# BatangHanda landing page

The feedback API needs PHP 7.4 or later with `pdo_sqlite`. Opening `index.html` directly or publishing only to a static host such as GitHub Pages will not run the feedback API.

## Railway deployment

Deploy this repository as a PHP Docker service using the included `Dockerfile`. Attach a persistent volume mounted at `/data`, then set the service variable `BH_FEEDBACK_DB_PATH=/data/feedback.sqlite`. The PHP process must have write access to that volume. The persistent volume keeps ratings across service redeploys; deploying without one can lose feedback. Keep PHP `display_errors` disabled in production so diagnostics go to logs instead of API responses.

Railway automatically detects the root `Dockerfile`. The included startup script listens on Railway's `PORT` and prepares `/data` for Apache. In the service's Settings, explicitly set these deployment values:

| Setting | Value |
| --- | --- |
| Root Directory (Source) | Blank or `/` for this repository |
| Dockerfile Path (Build) | `Dockerfile` |
| Start Command | `/usr/local/bin/batanghanda-start` |
| Healthcheck Path | `/api/feedback.php?limit=1` |
| Healthcheck Timeout | `60` seconds |
| Restart Policy | `On Failure` |
| Maximum Restart Retries | `3` |

The health check verifies the feedback API and database. `railway.json` contains the same settings for legacy services that already use Config as Code. Railway documents that new services cannot opt into `railway.json`/`railway.toml`; legacy support ends December 1, 2026. Set the values directly in Settings for a new service. See Railway's [configuration docs](https://docs.railway.com/config-as-code), [Dockerfile](https://docs.railway.com/builds/dockerfiles), [volume](https://docs.railway.com/volumes), and [health check](https://docs.railway.com/deployments/healthchecks) documentation.

### Troubleshooting startup

The image build and startup explicitly disable Apache's `mpm_event` and `mpm_worker`, enable only `mpm_prefork` for PHP, and run `apache2ctl -t` before starting. A successful startup logs `BatangHanda: starting Apache on port ... with mpm_prefork.` If that line is missing, inspect the build logs and deployment settings to confirm this Dockerfile and startup command are being used.

In Railway's deployment details, confirm the start command and health check path match the table above. If they are absent, set them directly in service Settings. Confirm the Root Directory contains this Dockerfile, the build log uses `php:8.4-apache-bookworm`, and deploy the latest commit. Keep the volume mounted only at `/data`.

A build error ending in `snapshot-target-unpack/Dockerfile: not a directory` indicates that Railway is treating the Dockerfile as a directory. The Root Directory must name a folder (blank or `/` for this repository); `Dockerfile` is the file path used for the build. Check these as separate settings, then deploy again.

Railway's Post-deploy phase drains and removes the previous deployment; application readiness is checked through the configured health check. A successful image build alone does not confirm that Apache is serving requests. See [deployment phases](https://docs.railway.com/deployments/troubleshooting/slow-deployments).

For a service exposed exclusively through Railway's public HTTP edge, also set `BH_FEEDBACK_TRUST_RAILWAY_PROXY=1`. This uses Railway's documented [`X-Real-IP` client address](https://docs.railway.com/networking/public-networking/specs-and-limits) for the submission limit, instead of grouping all visitors under the proxy's address. The header must contain a valid IP address. Leave this flag unset for local development, direct public servers, or TCP ingress, where visitors can supply their own header.

## Local development

Serve this folder with Apache/PHP (for example, XAMPP at `http://localhost/bh_landingpage/`). PHP must be able to write to `storage/`. Restart Apache after enabling `pdo_sqlite`. Alternatively, run `php -S 127.0.0.1:8080 -t . dev-router.php` from this folder. The included router blocks private storage and source-control files; `.htaccess` alone is not read by the PHP development server.

## Google Search setup

The page title, description, canonical URL, and `WebSite` structured data identify the site as BatangHanda App at `https://batanghanda.online/`. The root `robots.txt` allows crawling and points to the one-page `sitemap.xml`. The Dockerfile includes both files in the deployment. A missing robots file or sitemap alone does not prevent indexing; these additions help communicate the preferred URL and support discovery.

After deploying these files:

1. Confirm `https://batanghanda.online/`, `https://batanghanda.online/robots.txt`, and `https://batanghanda.online/sitemap.xml` return HTTP 200 publicly.
2. Open [Google Search Console](https://search.google.com/search-console/), add the Domain property `batanghanda.online`, and verify ownership using the DNS TXT record Google provides. Add it at the domain's DNS provider and keep it in place. If you already verified the domain, use that property.
3. In **Sitemaps**, submit `https://batanghanda.online/sitemap.xml`.
4. In **URL inspection**, inspect `https://batanghanda.online/`, choose **Test live URL**, and, if Google can access and index it, choose **Request indexing**. Resolve any access or indexing errors the tool reports.
5. Monitor **Page indexing** and **Performance** for impressions and queries such as `BatangHanda App`. Link to the landing page from the app's Facebook page and GitHub repository so people can find the same website from those profiles.

These steps require the owner's Google account and DNS access; publishing the code alone does not verify ownership or submit an indexing request. Google says crawling can take a few days to a few weeks, and indexing or a particular ranking is not guaranteed. See Google's [ownership verification guide](https://support.google.com/webmasters/answer/9008080), [sitemap guide](https://developers.google.com/search/docs/crawling-indexing/sitemaps/build-sitemap), and [recrawling guide](https://developers.google.com/search/docs/crawling-indexing/ask-google-to-recrawl).

## Feedback storage and operations

Ratings, optional names, comments, and suggestions are saved in `storage/feedback.sqlite` and are public. No login or email is required. The database starts empty. The `storage/.htaccess` file blocks Apache downloads; ensure Apache permits its access rules (`AllowOverride AuthConfig`). Other web servers must explicitly deny requests to `/storage/`, or store the database outside the web root using the absolute `BH_FEEDBACK_DB_PATH` environment variable.

Back up feedback with SQLite's backup command/API, or stop writes before copying the database and any WAL files. Keep backups and the database out of source control. To remove abusive feedback, use SQLite administration to delete the relevant row from the `feedback` table by its `id`; do not change the private `settings` or rate-limit tables.

Feedback is published immediately, with a honeypot and a limit of five submissions per IP address in ten minutes. The database stores a salted hash for this limit, not plaintext IP addresses; the web server may separately keep access logs. Shared networks also share the limit. These controls do not prevent all spam or duplicate ratings, so monitor public comments and add moderation if traffic requires it. Do not ask visitors to post private information.

`GET api/feedback.php?limit=6&offset=0` returns the aggregate rating and newest feedback. `POST api/feedback.php` accepts JSON with an integer `rating` from 1–5 and optional `name` (60 characters), `comment` (1,000), `suggestion` (1,000), and an empty `website` honeypot. Text is plain text and must be displayed using `textContent`, never HTML.

Run `php tests/feedback-api-test.php` to test HTTP validation, pagination, persistence, and rate limiting against a disposable database. This requires PHP CLI with `pdo_sqlite` and `proc_open` enabled.

Run `node --test tests/feedback-ui-test.mjs` to verify the feedback controller's loading, submission, error recovery, pagination, and safe text rendering without installing dependencies. These checks do not verify browser layout.

Run `node --test tests/startup-test.mjs` to check startup sequencing, port handling, and failure behavior using Bash and isolated command stubs. This does not build the Docker image or run real Apache.
