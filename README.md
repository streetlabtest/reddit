# Quiet Feed (GitHub Pages)

A minimalist, allowlisted subreddit reader that:
- Builds a static `feed.json` every 4 hours with GitHub Actions from the subreddits listed in `subreddits_source.txt`.
- Lets the reader choose which of those subreddits to show (stored in localStorage). Subreddits not in `subreddits_source.txt` are never fetched; add a line there to make one available.
- Keeps earlier posts from a subreddit when a fetch fails (e.g. rate limiting), and leaves `feed.json` unchanged if every fetch fails.
- Shows a finite number of posts per session, posts only (no in-app comments).
- Optionally provides a "Comments" link that opens the Reddit thread in a new tab.
