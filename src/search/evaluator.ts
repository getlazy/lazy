/**
 * Query evaluator for Lucene-style search.
 *
 * Evaluates a parsed AST against task data loaded from storage.
 * Each task is evaluated with its associated turns, commits, and comments.
 */

import type { QueryNode } from './parser';
import type { Task, Comment, Turn, Commit } from '../types';
import type { SearchResult } from '../storage/types';

/** All data associated with a single task, used for evaluation. */
export interface TaskData {
  task: Task;
  turns: Turn[];
  commits: Commit[];
  comments: Comment[];
}

/**
 * Evaluate a query AST against a TaskData record.
 * Returns true if the task matches the query.
 */
export function evaluateQuery(node: QueryNode, data: TaskData): boolean {
  switch (node.type) {
    case 'and':
      return evaluateQuery(node.left, data) && evaluateQuery(node.right, data);

    case 'or':
      return evaluateQuery(node.left, data) || evaluateQuery(node.right, data);

    case 'not':
      return !evaluateQuery(node.operand, data);

    case 'field':
      return evaluateField(node.field, node.value, data);

    case 'in':
      return evaluateIn(node.scope, node.value, data);

    case 'has':
      return evaluateHas(node.scope, data);

    case 'date':
      return evaluateDate(node.field, node.op, node.value, data);

    case 'text':
      return evaluateText(node.value, data);
  }
}

function textContains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

function evaluateField(
  field: 'status' | 'goal' | 'code',
  value: string,
  data: TaskData
): boolean {
  switch (field) {
    case 'status':
      return data.task.status === value;

    case 'goal':
      return textContains(data.task.goal, value);

    case 'code':
      return data.task.code !== null && data.task.code.toLowerCase() === value.toLowerCase();
  }
}

function evaluateIn(
  scope: 'turns' | 'commits' | 'comments' | 'conversations',
  value: string,
  data: TaskData
): boolean {
  switch (scope) {
    case 'turns':
      return data.turns.some(t => textContains(t.content, value));

    case 'commits':
      return data.commits.some(c => textContains(c.message, value));

    case 'comments':
      return data.comments.some(c => textContains(c.content, value));

    case 'conversations':
      // Conversations are standalone entities, not associated with tasks.
      // They are searched separately in the search command.
      return false;
  }
}

function evaluateHas(
  scope: 'commits' | 'turns' | 'comments',
  data: TaskData
): boolean {
  switch (scope) {
    case 'commits':
      return data.commits.length > 0;
    case 'turns':
      return data.turns.length > 0;
    case 'comments':
      return data.comments.length > 0;
  }
}

function evaluateDate(
  field: 'created' | 'updated',
  op: '>' | '<',
  dateStr: string,
  data: TaskData
): boolean {
  const dateMs = new Date(dateStr + 'T00:00:00Z').getTime();
  if (isNaN(dateMs)) return false;

  let taskTs: number;
  if (field === 'created') {
    taskTs = data.task.created_at;
  } else {
    // "updated" = last activity timestamp: completed_at or created_at
    taskTs = data.task.completed_at ?? data.task.created_at;
  }

  if (op === '>') {
    return taskTs > dateMs;
  } else {
    return taskTs < dateMs;
  }
}

function evaluateText(value: string, data: TaskData): boolean {
  // Free-text search across all content
  if (data.task.code && textContains(data.task.code, value)) return true;
  if (textContains(data.task.goal, value)) return true;
  if (data.task.prompt && textContains(data.task.prompt, value)) return true;
  if (data.turns.some(t => textContains(t.content, value))) return true;
  if (data.commits.some(c => textContains(c.message, value))) return true;
  if (data.comments.some(c => textContains(c.content, value))) return true;
  return false;
}

/**
 * Build search results from a matched task, extracting context from all matching fields.
 * This provides detailed match information similar to the existing search output.
 */
export function buildSearchResults(
  node: QueryNode,
  data: TaskData
): SearchResult[] {
  const results: SearchResult[] = [];
  const taskCode = data.task.code ?? null;
  const taskGoal = data.task.goal;

  // Collect all text terms from the query for context extraction
  const textTerms = extractTextTerms(node);

  if (textTerms.length === 0) {
    // No text terms (e.g., pure status/has/date query) — return a task-level result
    results.push({
      entity_type: 'task',
      entity_id: data.task.id,
      task_id: data.task.id,
      task_code: taskCode,
      task_goal: taskGoal,
      content: taskGoal,
      match_context: taskGoal,
    });
    return results;
  }

  // Check each content area for text matches
  for (const term of textTerms) {
    // Task code
    if (taskCode && textContains(taskCode, term)) {
      results.push({
        entity_type: 'task',
        entity_id: data.task.id,
        task_id: data.task.id,
        task_code: taskCode,
        task_goal: taskGoal,
        content: `code: ${taskCode}`,
        match_context: taskCode,
      });
    }

    // Goal
    if (textContains(data.task.goal, term)) {
      results.push({
        entity_type: 'task',
        entity_id: data.task.id,
        task_id: data.task.id,
        task_code: taskCode,
        task_goal: taskGoal,
        content: data.task.goal,
        match_context: extractContext(data.task.goal, term),
      });
    }

    // Prompt
    if (data.task.prompt && textContains(data.task.prompt, term)) {
      results.push({
        entity_type: 'prompt',
        entity_id: data.task.id,
        task_id: data.task.id,
        task_code: taskCode,
        task_goal: taskGoal,
        content: data.task.prompt,
        match_context: extractContext(data.task.prompt, term),
      });
    }

    // Turns
    for (const turn of data.turns) {
      if (textContains(turn.content, term)) {
        results.push({
          entity_type: 'turn',
          entity_id: turn.id,
          task_id: data.task.id,
          task_code: taskCode,
          task_goal: taskGoal,
          content: turn.content,
          match_context: extractContext(turn.content, term),
        });
      }
    }

    // Commits
    for (const commit of data.commits) {
      if (textContains(commit.message, term)) {
        results.push({
          entity_type: 'commit',
          entity_id: commit.id,
          task_id: data.task.id,
          task_code: taskCode,
          task_goal: taskGoal,
          content: commit.message,
          match_context: commit.message,
        });
      }
    }

    // Comments
    for (const comment of data.comments) {
      if (textContains(comment.content, term)) {
        results.push({
          entity_type: 'comment',
          entity_id: comment.id,
          task_id: data.task.id,
          task_code: taskCode,
          task_goal: taskGoal,
          content: comment.content,
          match_context: extractContext(comment.content, term),
        });
      }
    }
  }

  // Deduplicate by entity_type + entity_id
  const seen = new Set<string>();
  return results.filter(r => {
    const key = `${r.entity_type}:${r.entity_id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Extract all text search terms from a query AST.
 * This includes text nodes, in: values, goal: values, and field values
 * that involve text matching.
 *
 * Note: Does NOT descend into NOT nodes — negated terms are exclusion
 * criteria, not content we want to highlight in results.
 */
function extractTextTerms(node: QueryNode): string[] {
  switch (node.type) {
    case 'and':
    case 'or':
      return [...extractTextTerms(node.left), ...extractTextTerms(node.right)];
    case 'not':
      // Don't extract terms from negated expressions
      return [];
    case 'text':
      return [node.value];
    case 'in':
      return [node.value];
    case 'field':
      if (node.field === 'goal') return [node.value];
      return [];
    case 'has':
    case 'date':
      return [];
  }
}

/**
 * Extract a context snippet around a match.
 */
function extractContext(text: string, term: string, contextChars: number = 40): string {
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return text.substring(0, 80);

  const start = Math.max(0, idx - contextChars);
  const end = Math.min(text.length, idx + term.length + contextChars);

  let result = text.substring(start, end).replace(/\s+/g, ' ').trim();

  if (start > 0) result = '...' + result;
  if (end < text.length) result = result + '...';

  return result;
}
