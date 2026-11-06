# Writing pull request notes

Notes are for a reviewer who has a minute. Keep them short, in bullets, and about what changes for users. Whoever writes them, person or agent, follows this file.

## Title

Like the commit messages: `feat: …`, `fix: …` or `chore: …`, then what the change does in plain words.

## Body

Use these sections in this order. Leave out any that would be empty.

```markdown
One sentence: what the PR is for.

## What's new
- `command --flag`: what it does for the user.

## Fixes
- What was wrong, in user terms, and that it's fixed.

## Screenshots
| What it shows | What it shows |
| --- | --- |
| ![alt text](url) | ![alt text](url) |

## Notes
- Only what a reviewer needs to know or decide: new dependencies, package size, follow-ups, known limits.

## Testing
- `pnpm run test`: N/N. `pnpm run test:render` (Chrome): N/N.
- What was checked by hand, and what wasn't tested.
```

## Rules

- One line per bullet. Start with the command, flag or file in backticks, then the effect.
- Say what users see, not how the code does it. Add implementation detail only when a reviewer has to check it.
- No more than about 10 bullets per section. Merge small related changes into one bullet.
- Numbers instead of adjectives: test counts, file sizes, versions.
- Say what didn't run or wasn't tested, such as live API tests skipped in CI.
- Describe the PR as a whole. When new commits land, rewrite the notes to match; don't append a log of pushes.

## Screenshots

Add one for anything users see: terminal screens (login, help, errors) and rendered output (PNG, SVG, Mermaid).

- Render images with the CLI itself at `--scale 2`, from small example files with neutral content.
- For terminal screens, capture the real output of the built CLI (`dist/main.js`) in color, not a mockup.
- Show before and after for a visible fix. When the difference doesn't show in an image, describe it in Fixes instead.
- Host the images outside the repo, for example in a GitHub gist: clone the gist, add the PNGs, push, and link `https://gist.githubusercontent.com/<user>/<gist-id>/raw/<file>.png`.
- Put them in a two-column table with a short caption above each image.
