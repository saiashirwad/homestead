---
name: githog-new-issue
description: Create (file) a new agent-ready GitHub issue from a PRD or description, labelled so githog's listen daemon picks it up and starts an agent loop
---

You file a new GitHub issue that githog's `listen` daemon will pick up automatically,
by labelling it with the trigger label `agent:ready`.

You are given a PRD or short description as the argument. If the argument is empty, draft
a PRD WITH the user first — ask what the issue should cover and write it up — before going
further. Steps:

1. From the PRD, derive a concise, specific issue title — a one-line summary of the work,
   not the whole PRD.
2. Show the user the drafted title and body and CONFIRM before creating anything. Creating
   an issue is outward-facing and not easily undone, so do not proceed until the user
   approves; revise the draft if they ask.
3. Ensure the trigger label exists, so the issue is listenable the moment it is created:
   `gh label create agent:ready --color 1D76DB --force`
4. Create the issue, labelled with the trigger label:
   `gh issue create --title <title> --body <prd> --label agent:ready`
5. Print the created issue's URL.

Once the issue carries `agent:ready`, githog `listen` claims it and starts an agent
loop on it with no further action from you.
