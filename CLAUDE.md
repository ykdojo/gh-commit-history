# gh-commit-history

Visualize a GitHub user's commit history (all years, daily/weekly/monthly, per-repo breakdown). Self-contained HTML + Plotly, powered by the `gh` CLI. Data comes from the commit search API (includes private repos), SHA-deduped so forks don't double-count. Published on npm as `gh-commit-history`.

## Planned / next steps (review before sharing widely)

- **Opt-in prompt before a long first fetch.** The full-history fetch uses the rate-limited commit search API and can take ~10-15 min on the first run (cached per quarter afterward, so later runs are fast). When little is cached yet and the requested span is large, prompt the user yes/no first - make clear it may take a while, and offer to limit the range (e.g. `--years`) to significantly cut the time. Cutoff is TBD: maybe "more than ~1 year of uncached history", or based on the number of quarters that need fetching. Decide during review.
- **Add a legend to the stacked "By repository" chart.** Right now `showlegend=false`: per-bucket top-N ranking makes the named repo set a large union (~40 repos in the 2-year view), and the hover already names each segment. We want a legend like gh-star-history's region breakdown chart (`showlegend:true`, `legend:{orientation:'h', y:-0.15, traceorder:'reversed', bgcolor:'transparent'}`). Decide how to keep it readable - e.g. only show the top-N overall repos (stable colors) in the legend rather than the full per-bucket union, or accept a longer horizontal legend. Check how it's done in gh-star-history.
- **Thorough testing, mostly automated**, before publishing more widely / sharing.
- Then publish/share.

## Notes

- Verify commit counts by cross-checking a repo against the REST `/repos/{repo}/commits?author=<login>` endpoint (different API than search); per-repo counts matched exactly for public and private repos.
- Generated `commit-history.html` and the cache (`~/.gh-commit-history/`) are not committed (gitignored / outside the repo).
