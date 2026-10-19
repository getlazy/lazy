# Builders

The Builders screen lists the builder conversations for a project; you reach it from **Builders** in the top navigation.

![The Builders screen](../../images/teams/teams-builders.png)

For what a builder is and how to use one, see [Builders in Lazy Teams](../../lazy-teams-builders.md).

## Section tabs

Two tabs sit above the title: **Builders** (this screen) and **Files**, which lists the files builders left in scratch for the whole project.

## Header and introduction

The title is **Builders**, with the project name above it as a link back to the project overview. A short paragraph explains that a builder runs from when it starts, or from a `/clear`, to the next `/clear`, and that you can open one to read its transcript, promote a passage into a task and see the files it left. It also says your builder runs next to the project: you can open it here, or with `lazy builder` in a clone logged in to the project.

## Starting your builder

One button starts, reopens or resumes your builder, and its label says which:

| Label | Shown when |
| --- | --- |
| **Open your builder** | one of your builders is running |
| **Resume your builder** | none is running and one of yours is stopped |
| **Start your builder** | neither |

If you are not allowed to open a builder, the button is replaced by a notice that a builder runs on the account of the person using it, so it can only be opened in your own name.

## Your builder

When one of your runs is not yet carried by a listed builder, a **Your builder** section appears above the list. Its row shows a state badge, when it started, and a note that its transcript is listed below once captured. The row links to the builder's page.

## Search transcripts

The **Search transcripts** box takes a keyword or pattern and has a **Find** button. With a query, the page lists **Matches**: each row gives the builder's title, its start time, the number of matches and an excerpt. If nothing matches you see **No matching builders**; clear the search to see every builder again.

## Builders list

Each row is one builder. The row shows the title and a line of details, and links to the builder's page. A badge on the right shows the state of its run, for example **Running** or **Stopped — resumable**. A builder with no badge has no run attached. An empty project shows **No builders yet**, and a builder is listed once its transcript has been captured.

## A builder's page

Opening a builder shows:

- **Details**: Id, Run, Started, Last activity, Branch, Messages, and Segments when the transcript was stitched from more than one.
- **Your builder** (only for your own run): the run's state, **Stop** while it runs, **Resume** while it is stopped, and **End**, which asks for confirmation and warns that the transcript is kept but the builder cannot be resumed. While it runs, a terminal is shown here.
- **Create a task from messages**: select the messages you want in the transcript, then choose **Create task**. You can set **Goal**, **Code**, **Parent task** and **Prompt**, and **Create backlog task** makes a task in the backlog without starting it. Empty fields use defaults, as the hints on the page describe.
- **Transcript**: the messages, paged with **Earlier** and **Later**.
- **Files this builder left**: the scratch files attributed to this builder.
