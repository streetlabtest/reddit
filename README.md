# Calm Feed (GitHub Pages)

A minimalist, allowlisted subreddit reader that:
- Lets one user choose subreddits (stored in localStorage).
- Fetches RSS feeds only for those subreddits.
- Shows posts only (no in-app comments).
- Provides a "Comments" link that opens the Reddit thread in a new tab.

## Deploy on GitHub Pages

Commit `index.html`, `styles.css`, and `app.js` to a GitHub repository.

Then in GitHub:
Settings → Pages → Build and deployment → Source = "Deploy from a branch" → Branch = `main` (or `master`) and `/ (root)`.

Your site will be served at:
https://<username>.github.io/<repo>/

## Notes

This is a static site, so it cannot set server-side CORS headers.
To fetch RSS in the browser, it uses the AllOrigins public CORS proxy:
https://api.allorigins.win/raw?url=<encoded target url>

If the proxy is rate-limited or down, feed loading may fail. For heavier use, replace the proxy with a self-hosted one.
