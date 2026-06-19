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
| `--exclude-private` | Exclude private repositories (private are included by default) |
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

1. Fetches your commits via GitHub's commit **search API** (`author:<you>`), one date window per calendar quarter. Any window with more than 1000 results (the API's cap) is recursively split by date, so every commit is captured. Unlike the `contributionsCollection` API, search includes **private** repositories.
2. De-dupes by commit SHA: the same commit copied into someone's fork shares its SHA, so only the canonical copy (a repo you own, else a non-fork) is kept. Forks that merely mirror your commits disappear; a fork where you authored *unique* commits keeps those.
3. Caches each completed quarter to `~/.gh-commit-history/<user>.json`. Only the current quarter is refetched on subsequent runs.
4. Embeds the per-repo daily series in a self-contained HTML file with an interactive [Plotly.js](https://plotly.com/javascript/) chart (loaded from CDN), and opens it in your browser. All aggregation, ranking, and range filtering happen client-side, so the controls are instant.

## Notes

- "Commits" means commits **authored by you** (matched on your linked email) on repositories' default branches, across every repo your `gh` login can see - including private ones.
- **Private repos are included by default** (use `--exclude-private` to omit them). This only works for your own account - you can't read other users' private repos.
- The search API is rate-limited (30 requests/min) and capped at 1000 results per query, so the **first full-history fetch takes a few minutes**. It's cached afterward, so later runs are fast.
- In the very rare case of a single day with more than 1000 commits, counts could be slightly under-reported; the tool warns when this happens.
