# S8: Claude Code with an image in the message, and resuming after an interrupt

Status: **partly done (2026-10-04)**. Verdict: **image input: yes** (local). **Resume after a
SIGTERM, and `--model` on `--resume`: not yet verified.**

The questions behind the session composer plan (model per message, Send now, pasted images):
can `claude -p` take an image as well as text, and does a turn that Launch killed resume cleanly,
on another model if the next message asks for one?

## 1. Image input through `--input-format stream-json`: yes

Run locally with Claude Code **2.1.289**, outside a sandbox:

```sh
claude -p --input-format stream-json --output-format stream-json --verbose \
  --model claude-haiku-4-5 < in.jsonl
```

`in.jsonl` held ONE line:

```json
{"type":"user","message":{"role":"user","content":[
  {"type":"image","source":{"type":"base64","media_type":"image/png","data":"<base64>"}},
  {"type":"text","text":"<the question about the image>"}]}}
```

- The process **exits at EOF** of stdin, after one turn. It does not wait for more input.
- The output is the stream-json Launch already parses: the `system` `init` line (its
  `session_id`, the `--resume` id), the `assistant` lines and the `result` line.
- The image was **answered correctly**.

So a turn with images can write `turn-input.jsonl` and pipe it in, and the argv form
(`claude -p '<message>'`) stays for text-only turns. The fallback (an image saved under
`/workspace/.launch/attachments/` and its path named in the message, for Claude's Read tool) is
not needed for Claude Code.

## Not yet verified (needs a real session sandbox, through the egress proxy)

1. **Resume after an interrupt.** Start a turn, SIGTERM it mid-tool-call with the turn's own kill
   script (`turnKillScript`: SIGTERM, 5 s, SIGKILL), then `--resume <id>` with a new message.
   Check that the context survives and the resume is not refused. Launch's Send now
   (`mode: 'interrupt'`) depends on this. Its fallback is already in `turn.ts`: a `--resume` that
   ends at once as `error_during_execution` is retried once as a new conversation.
2. **A model switch on resume.** `--resume <id> --model claude-opus-5-5` after a Sonnet turn.
   The per-message model (`sessions.pending_model`) depends on this.
3. Item 1's image turn **inside the sandbox**, through the model proxy (`egress/anthropic.ts`),
   with `--resume`.

Run these end to end on dev-remote with a subscription session before relying on them.
