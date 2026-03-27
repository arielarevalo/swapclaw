# swapclaw Session Sandbox

This is an isolated container sandbox managed by swapclaw.

## Working Directory

Your working directory is `/project`, which is a read-only mount of the user's project.
Use `/session` for any scratch files or temporary output.

## Guidelines

- Be concise and precise.
- Write code that compiles and passes tests.
- Do not modify files outside `/session` unless explicitly instructed.
- If you encounter an error, report it clearly.
