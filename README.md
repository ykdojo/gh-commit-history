# gh-commit-history

Visualize your GitHub commit history across **all your years on one screen** as an interactive chart. Powered by the [GitHub CLI](https://cli.github.com/) - no API tokens needed.

GitHub's contribution calendar only shows one year at a time, daily-only, with no per-repo breakdown. This shows your whole history with switchable daily / weekly / monthly granularity, a flexible range selector, and a per-repository breakdown.

```
npx gh-commit-history ykdojo
```

Defaults to your authenticated user if no username is given.

## Prerequisites

- [Node.js](https://nodejs.org/) >= 16
- [GitHub CLI](https://cli.github.com/) installed and authenticated (`gh auth login`)

## Usage

```bash
npx gh-commit-history [username] [options]
```

### Options

| Flag | Description |
|------|-------------|
| `--years <n>` | Limit to the past n years (default: all history since account creation) |
| `-g, --granularity <g>` | `daily`, `weekly` (default), or `monthly` |
| `--style <name>` | `blue` (default), `green`, or `purple` |
| `-o, --output <path>` | Output file path (default: `commit-history.html`) |
| `--no-open` | Don't auto-open the browser |
| `--no-cache` | Skip cache and fetch fresh data |
| `-h, --help` | Show help |

### Examples

```bash
# Your whole history, weekly
npx gh-commit-history

# Someone else, monthly
npx gh-commit-history ykdojo -g monthly

# Last 5 years, green accent
npx gh-commit-history torvalds --years 5 --style green
```

## The charts

The generated page has three linked charts plus shared controls (granularity, range, top-N):

1. **Total commits over time** - one bar per day/week/month across your whole history, on one continuous timeline. Hover shows the top 5 repos for that period.
2. **By repository** - a stacked bar chart where each color is a repo. It ranks **per period**, so each week shows *that week's* actual top-N repos and "other" only ever holds that period's genuinely-minor tail (a repo can never hide in "other" while being a period's top contributor). Hover shows the full per-period breakdown.
3. **Overall breakdown by repository** - horizontal bars of the top-N repos for the selected range, with percentages. Hovering "other" expands to show what's inside it.

### Controls

- **Granularity** - daily / weekly / monthly. Re-aggregates live; this is also your smoothing control.
- **Range** - All time / Past… (1 week up to 10 years) / Custom range (date pickers). The per-repo ranking recomputes for the visible range.
- **Top repos** - how many repos to show individually before the rest roll into "other".

## How it works

1. Fetches commit counts via GitHub's GraphQL `contributionsCollection` API, one request per calendar quarter. A quarter has at most 92 days, so a single page of 100 nodes always captures every commit-day with no pagination - and summing the per-day, per-repo counts exactly matches GitHub's `totalCommitContributions`.
2. Caches each completed quarter to `~/.gh-commit-history/<user>.json`. Only the current quarter is refetched on subsequent runs.
3. Embeds the daily, per-repo series in a self-contained HTML file with an interactive [Plotly.js](https://plotly.com/javascript/) chart (loaded from CDN), and opens it in your browser. All aggregation and re-ranking happen client-side, so the controls are instant.

## Notes

- "Commits" means commit contributions as GitHub counts them: commits attributed to your account (via a linked email) on repositories' default branches.
- Counts reflect **public** commits. GitHub's API does not itemize private-repository commits by repo (they're aggregated into a restricted count), so private work is not shown.
- If a single repo had commits on more than 100 distinct days within one quarter, counts could be slightly under-reported; the tool warns when this happens (rare).
