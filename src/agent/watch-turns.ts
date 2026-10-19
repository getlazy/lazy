import type { Storage } from '../storage';
import type { Turn } from '../types';

const RECENT_TURNS = 5;

function turnLine(turn: Turn): string {
  const label = turn.turn_type === 'review' && turn.review
    ? `Review: ${turn.review.verdict}`
    : turn.content.split('\n').find((line) => line.trim()) ?? '';
  const safeLabel = label.replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ').trim().slice(0, 100);
  return `turn #${turn.sequence} ${new Date(turn.timestamp).toISOString()} ${turn.role}: ${safeLabel || '(no text)'}`;
}

/** The task timeline, without ever mistaking another turn's session log for live output. */
export class WatchTurnTracker {
  private count = -1;
  private lastSequence = 0;
  private lastHumanTimestamp = Date.now();

  constructor(
    private readonly storage: Storage,
    private readonly taskId: string,
    private readonly emit: (line: string) => void,
  ) {}

  get turnStart(): number { return this.lastHumanTimestamp; }

  async refresh(): Promise<void> {
    const count = await this.storage.getTurnCountByTaskId(this.taskId);
    if (count === this.count) return;
    const session = await this.storage.getSessionByTaskId(this.taskId);
    if (!session) return;
    const turns = await this.storage.getSessionTurns(session.id);
    const human = turns.filter((turn) => turn.role === 'human').at(-1);
    this.lastHumanTimestamp = human?.timestamp ?? this.lastHumanTimestamp;
    if (this.count === -1) {
      this.emit('Recent task turns (full history in the task timeline):');
      for (const turn of turns.slice(-RECENT_TURNS)) this.emit(turnLine(turn));
      if (!turns.length) this.emit('(no completed turns yet)');
    } else {
      for (const turn of turns) {
        if (turn.sequence > this.lastSequence) this.emit(turnLine(turn));
      }
    }
    this.lastSequence = turns.at(-1)?.sequence ?? 0;
    this.count = count;
  }
}
