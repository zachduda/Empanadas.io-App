# Site changes the iOS app needs

The iOS app is a native shell around empanadas.io, so part of the work is on
the site (the `zachduda/Empanadas-io` repo). Everything below refers to files
under `html/` there.

## Status

Done in zachduda/Empanadas-io#70: sections 1, 2, 3 and 5, the dashboard part
of section 4, and the coffee links in section 6. Section 8, the `/v2/ios/` API,
is in the site's `html/v2/ios/`, profiles and Find Friends included. The app itself hides the navbar
(`Resources/bridge.js`), since `getNav()` lives in config.php, which is not in
that repo. Section 9, the whole sign-in in the system browser, is the site's
`html/v2/auth/app.php` and `html/v2/ios/signin.php`.

Still to do:

- **Deploy section 9 before shipping the welcome screen.** An app with it
  cannot sign in against a site without `/v2/auth/app.php`.
- **Sign in with Apple** (section 6). The Apple provider in
  `v2/auth/flow.php` is commented out and needs its key on the server.
- **Passkeys** (section 7). Signing in with one no longer depends on this:
  it happens in the system browser (section 9). Adding a passkey from the
  account page still happens in the app's web view, which needs the
  apple-app-site-association file. It is in the site's repo
  (`html/.well-known/`, Team ID `MWBT4TC7JN`): check that the live site serves
  it as described there, then try adding one on a device.
- **Phone-width check** (end of section 4).

The sections below are kept as the record of what the app expects from the site.

## 1. Recognise the iOS app

The app adds `EmpanadasiOS/<version> native-app` to WebKit's user agent. For
example:

```
Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 EmpanadasiOS/1.0.0 native-app
```

The token is deliberately **not** `Empanadas.io/1.0.0`. `desktopAppVersion()`
would read that as the desktop app and compare it against the desktop release
on GitHub, which sends the app to `/appoutofdate.html`. `native-app` already
makes `login.js` skip its browser version check.

Add this next to `desktopAppVersion()` in `v2/_lib.php`:

```php
if (!function_exists('iosAppVersion')) {
    /**
     * Version of the iOS app making this request, or null.
     * The app is github.com/zachduda/Empanadas.io-App/tree/main/ios.
     *
     * @param  string|null $useragent Defaults to this request's.
     * @return string|null            e.g. "1.0.0"
     */
    function iosAppVersion($useragent = null)
    {
        $ua = $useragent === null ? clientUserAgent() : (string) $useragent;
        if (!preg_match('~\bEmpanadasiOS/(\d+\.\d+\.\d+)\b~', $ua, $m)) {
            return null;
        }
        return $m[1];
    }
}
```

## 2. Send sign-ins out to the browser

Since section 9 the app signs in entirely in the system browser, so this is
only used by the account page's Connect buttons now.

Google refuses OAuth inside a WKWebView. The app already handles the
desktop app's browser sign-in (`/v2/auth/browser.php?t=` →
`empanadas-io://auth?...`) using `ASWebAuthenticationSession`. The site only
needs to offer that flow to the iOS app. In `appBrowserSignIn()`:

```php
function appBrowserSignIn($useragent = null)
{
    if (iosAppVersion($useragent) !== null) {
        return true;
    }
    $app = desktopAppVersion($useragent);
    return $app !== null && version_compare($app, DESKTOP_APP_BROWSER_SIGNIN, '>=');
}
```

## 3. Skip the SSO roundabout in the app

Change `v2/auth/js.php` the same way it already treats the desktop app. The
app's main pages never leave empanadas.io:

```php
$in_app = desktopAppVersion() !== null || iosAppVersion() !== null;
```

## 4. Leave the site's navigation out of the page

The app replaces the site's navigation with native tabs (Home, Games,
Settings). Taps on the dashboard's links to `/v2/account` and to the games
already open the native screens. Leave out what is now duplicated when
`iosAppVersion() !== null`:

- the navbar from `getNav()`. The app now hides `<nav id="nav">` itself, so
  this is optional;
- the dashboard footer buttons (Settings / Feedback / Sign Out). Sign Out is
  in the native Settings screen;
- the "Desktop App" card on `v2/account/index.php`.

Doing this server-side avoids a flash of the navbar. For anything decided in
the browser, `<html>` also carries `data-native-app="ios"` and
`window.empanadasApp` is defined (see `ios/Empanadas/Resources/bridge.js`).

Check that every page the app shows works at phone width. The desktop
window's minimum width was 975px, so some pages may never have been tested
narrow.

## 5. `getdata.php?type=app_settings` (native Settings)

The native Settings screen reads the account's settings from this endpoint.
It writes them through `account_edit.php` exactly as the account page does
(`account_change=settings&<field>=<0|1|…>&csrf=`). Until the endpoint exists,
Settings falls back to opening the web account page.

Add this to the type chain in `v2/getdata.php`. The defaults match
`v2/account/index.php`:

```php
} else if($type == "app_settings") {
    // The iOS app's native Settings screen. Same values and defaults as
    // v2/account/index.php; changes go through account_edit.php as usual.
    $result = array("result" => 0);
    $sql = "SELECT username, email, profile_pic, settings, birthday FROM users WHERE id = ? LIMIT 1";
    if($stmt = mysqli_prepare($link, $sql)) {
        $uid = intval(sessionValue("id"));
        mysqli_stmt_bind_param($stmt, "i", $uid);
        if(mysqli_stmt_execute($stmt)) {
            mysqli_stmt_bind_result($stmt, $u_name, $u_email, $u_pfp, $u_settings, $u_birthday);
            if(mysqli_stmt_fetch($stmt)) {
                $blob = json_decode((string) $u_settings);
                $get = function ($path, $default) use ($blob) {
                    $node = $blob;
                    foreach(explode('.', $path) as $key) {
                        if(!is_object($node) || !isset($node->$key)) { return $default; }
                        $node = $node->$key;
                    }
                    return is_scalar($node) ? (int) $node : $default;
                };
                $theme = $get('theme', 0);
                $result = array(
                    "result"       => 1,
                    "username"     => (string) $u_name,
                    "email"        => (string) $u_email,
                    "pfp"          => !empty($u_pfp) ? LG_PFP_PATH . $u_pfp : DEFAULT_PFP_SRC,
                    "has_birthday" => !empty($u_birthday) && $u_birthday !== '0000-00-00',
                    "settings"     => array(
                        "publicaccount" => $get('profile.is_public', 1),
                        "starsign"      => $get('profile.starsign', 1),
                        "allownf"       => $get('profile.new_friends', 1),
                        "analytics"     => $get('analytics', 1),
                        "theme"         => ($theme < 0 || $theme > 2) ? 0 : $theme,
                        "promoemails"   => $get('emails.promo', 1),
                        "otheremails"   => $get('emails.other', 1),
                        "recapemails"   => $get('emails.recap', 1),
                        "newsignins"    => $get('emails.signin', 1),
                    ),
                    // The session's current token, NOT a regenerated one:
                    // regenerating would break an account page open on the
                    // web at the same time.
                    "csrf"         => csrfToken(),
                );
            }
        }
        closeStmt($stmt);
    }
    $result = json_encode($result);
}
```

`csrfToken()` and `LG_PFP_PATH` come from config.php, which is not in the
repo, so check the call signatures. `pfp` may be a path or a full URL; the app
resolves it against `https://empanadas.io`.

The app sends the web views' cookies **and their exact user agent** with these
requests, because `checkSession()` ties a session to its user agent.

## 6. App Review blockers

- **The coffee interstitial (`v2/ad.php`).** The dashboard redirects to it via
  `seenAd()`, and it offers to turn the pop-ups off for anyone who buys a
  coffee. Inside an iOS app, paying outside the app to remove something is a
  guideline 3.1.1 rejection. Skip it, and hide other "Buy Me Coffee" links,
  when `iosAppVersion() !== null`. These are in `login.js`'s rotating
  messages, the dashboard's thank-you line and `updates.html`.
- **Sign in with Apple (guideline 4.8).** If the app offers Google, GitHub or
  Discord sign-in, it must also offer Sign in with Apple. The login page
  already has the button (`#swapple`), hidden. Turn it on. It goes through the
  same browser flow, and `appleid.apple.com` is already in the app's allowed
  hosts.
- **Account deletion (guideline 5.1.1(v)).** This is done in the app (Settings
  → Delete Account, using `account_change=delete_account&cp=DELETE`). After a
  deletion the site should not redirect to anything that asks for money.

## 7. Passkeys in the app

Signing in with a passkey happens in the system browser (section 9), which
needs nothing from the app. For passkeys to work in the app's web views (the
account page's "add a passkey"), serve
this at `https://empanadas.io/.well-known/apple-app-site-association`
(`Content-Type: application/json`, no redirect). `MWBT4TC7JN` is the Apple
Developer Team ID, the same as `DEVELOPMENT_TEAM` in `project.yml`:

```json
{
  "webcredentials": {
    "apps": ["MWBT4TC7JN.io.empanadas.app"]
  }
}
```

The app already has the matching `webcredentials:empanadas.io` entitlement.
Passkeys are always for `empanadas.io` (`pkRpId()` in `v2/auth/passkey.php`),
so no other domain needs one.

## 8. `/v2/ios/`: the app's own API

The native Settings screen reads the signed-in account from
`GET /v2/ios/account.php` (`html/v2/ios/account.php` on the site). It replaces
`getdata.php?type=app_settings` from section 5, which the app still falls back
to while `/v2/ios/` answers 404.

It is under `/v2/` because the session cookie is scoped to `/v2` and
Cloudflare caches what is outside it. At `/ios/` the app was sent no session
cookie, so every answer was `no_session`.

Every `/v2/ios/` endpoint answers in JSON, errors included, with a matching HTTP
status, so the app can say what went wrong instead of "couldn't be loaded":

```json
{ "ok": false, "api": 1, "reason": "no_session" }
```

Reasons: `no_session` (401), `wrong_method` (405), `not_found` (404),
`unavailable` (503, accounts are switched off), `server_error` (500).

A successful answer:

```json
{
  "ok": true, "api": 1,
  "account": {
    "id": 42, "username": "tester", "email": "t@example.com",
    "email_verified": true, "pending_email": null,
    "pfp": "/Content/Images/ProfilePics/lg/abc.jpeg",
    "pfp_small": "/Content/Images/ProfilePics/sm/abc.jpeg",
    "has_custom_pfp": true, "created_at": "2024-01-02 03:04:05",
    "birthday": "2000-01-02", "star_sign": "Capricorn",
    "connections": ["discord", "google"], "two_factor": true, "passkeys": 2
  },
  "has_birthday": true,
  "settings": { "publicaccount": 1, "starsign": 1, "allownf": 1, "analytics": 1,
                "theme": 0, "promoemails": 1, "otheremails": 1,
                "recapemails": 1, "newsignins": 1 },
  "csrf": "..."
}
```

Changes still go through `/v2/account_edit.php`, the same handler the website
uses, with that `csrf`: `account_change=settings&<field>=<value>` for a
setting, and `account_change=delete_account&cp=DELETE` for Delete Account,
which the app confirms in a native modal where the player types DELETE.

### The dashboard and the leaderboard

The Home tab is the dashboard drawn natively, from
`GET /v2/ios/dashboard.php` (`iosDashboard()` and `iosSpinHistory()` in
`v2/_lib.php`): the same tiles, game cards, meters, experience, friends and
Spin Progress chart as `v2/dashboard.php`. The chart is one point a day (the
day's highest lifetime spins, today's from the live total) rather than the
web chart's relative-label groups, since the app draws a date axis.

```json
{
  "ok": true, "api": 1,
  "account": { "username": "tester", "uuid": "ab-12", "pfp": "/Content/...",
               "has_custom_pfp": true, "email_verified": true, "days": 9 },
  "peppers": 12, "pumpkins": 4, "pumpkin_season": true,
  "spin":   { "lifetime": 280000, "prestige": 3, "ascends": 1, "spins": 50000, "progress": 2.5 },
  "flappy": { "high": 40, "recent": 10, "played": 9, "progress": 25.0 },
  "tower":  { "high": 0, "recent": 0, "played": 0, "progress": 0.0 },
  "xp":     { "total": 10500, "rank": "Seasoned Empanada", "icon": "💎",
              "next": null, "next_rank": null, "progress": 100.0 },
  "friends": { "total": 3, "online": 1, "pending": 2, "list": [
               { "username": "pal", "uuid": "cd-34", "pfp": "/x.png", "default_pfp": false,
                 "state": "online", "label": "Online" } ] },
  "spin_history": [ { "date": "2026-10-10", "spins": 280000 } ],
  "generated": 1760000000
}
```

The Leaderboard tab reads `GET /v2/ios/leaderboard.php`: the boards of
`/v2/beta/leader.php` (`leaderboard()`, the shared cache), plus `you`, the
player's own profile id, so the app can mark their row. It checks the session
without refreshing it, as `account.php` does.

```json
{
  "ok": true, "api": 1,
  "spin":   [ { "rank": 1, "id": "AB12", "username": "top", "pfp": "/Content/...",
                "default_pfp": false, "private": false, "score": 5000,
                "ascends": 2, "prestige": 7 } ],
  "flappy": [ { "rank": 1, "id": "ef56", "username": "bird", "private": false,
                "score": 80, "recent": 12 } ],
  "tower":  [],
  "you": "ab12", "generated": 1760000000, "age": 10, "ttl": 45
}
```

Both are kept on the device after every good answer, so the tabs open with
the last copy at launch and while offline.

### Profiles and Find Friends

The native My Profile, player profiles and Find Friends read two more
endpoints. Both check the session without refreshing it, as the others do.

`GET /v2/ios/profile.php` is the signed-in player's own profile, and
`GET /v2/ios/profile.php?id=<uuid>` anyone's (`iosProfile()` and
`iosProfileFriend()` in `v2/_lib.php`). It applies `v2/profile.php`'s rules:
a friends-only profile shows anyone but a friend its name, picture and badges
and nothing else (`xp`, `stats` and `friends` are null); presence and the star
sign are for friends; only your own friends list says who is online, and only
your own lists requests (both ways). An unknown or deactivated player is
`404 not_found`.

```json
{
  "ok": true, "api": 1,
  "profile": { "id": "ab12...", "username": "pal", "pfp": "/Content/...", "default_pfp": false,
               "is_self": false, "admin": false, "supporter": true, "private": false,
               "email_verified": null, "member_since": "2024-01-02 03:04:05", "days": 640,
               "presence": { "state": "online", "label": "Online" }, "bio": "plain text",
               "star_sign": { "name": "Leo", "symbol": "♌", "blurb": "..." } },
  "relationship": { "state": "friends", "accepts_requests": true },
  "xp": { "total": 733, "rank": "Grand Empanada", "icon": "🔥", "range": "500 - 1,000 XP",
          "next": 1000, "next_rank": "Eldest Empanada", "progress": 46.6,
          "breakdown": [ { "label": "Lifetime Spins", "xp": 429, "percent": 58 } ] },
  "stats": { "spin": { "lifetime", "current", "ascends", "prestige" },
             "flappy": { "high", "played", "recent" } | null,
             "tower": { "high", "played", "recent", "best_streak", "perfects" } | null,
             "peppers": { "current": 31, "lifetime": 35 }, "pumpkins": 0, "pumpkin_season": true },
  "friends": { "total": 3, "pending": 1, "list": [
               { "username": "emp", "id": "cd34...", "pfp": "/x.png", "default_pfp": false,
                 "relation": "friends|incoming|outgoing", "state": "online", "label": "Online",
                 "is_you": false } ] },
  "csrf": "..."
}
```

`relationship.state` is `self`, `friends`, `outgoing` (the viewer asked),
`incoming` (the player asked) or `none`. `email_verified` is only given for
your own profile; `bio` is the stored bio as plain text.

`GET /v2/ios/search.php?q=<name>&p=<page>` is `usersearch.php`'s search (2 to
16 characters, the same characters taken out; `400 invalid_search`
otherwise), 20 a page, exact matches first, with where the searcher stands with
each player:

```json
{ "ok": true, "api": 1, "query": "emp", "page": 0, "has_more": false,
  "results": [ { "id": "cd34...", "username": "emp", "pfp": "/x.png", "default_pfp": false,
                 "admin": false, "supporter": false, "vip": false, "private": false,
                 "relation": "none", "accepts_requests": true } ] }
```

Changes go through `/v2/account_edit.php` with the `csrf` token, as the web's
profile page sends them, and `uuid` is the id without its dashes:
`account_change=add_friend&uuid=`, `pending_friend&uuid=&r=1` (accept) or `r=0`
(decline), `delete_friend&uuid=&r=0` (unfriend, or take back a request), and
`bio&m=<text>` (one line, 200 characters, verified address only). Those
answer a stale token with the long CSRF_FAIL_MSG rather than `"csrf"`; the app
knows both.

### Send Feedback

`GET /v2/ios/feedback.php` describes the feedback form (`iosFeedbackForm()` in
`v2/_lib.php`): the subjects `v2/feedback.php` offers, under the codes
`account_edit.php` takes (`feedbackSubjects()`), with what each asks for.
The animated profile picture subject is listed only for supporters; it asks
for a link (`"input": "link"`) and offers no reply.

```json
{ "ok": true, "api": 1,
  "subjects": [ { "id": 1, "key": "general", "label": "General Feedback", "input": "message",
                  "placeholder": "What's on your mind?", "reply": true, "message_required": true } ],
  "default_subject": 1, "min_length": 6, "max_length": 2000,
  "email": "me@example.com", "email_verified": true, "csrf": "..." }
```

The app sends the form as `feedback.js` does:
`account_change=feedback&s=<id>&m=<message>&nr=1|0&sso=0` with the `csrf`
token. A data download (`message_required: false`) may go without a message.
Links to `/v2/feedback` (`?reason=<id>` picks the subject; not `?sso=`, which
is zachduda.com's form) open the native form instead of the page.

## 9. The whole sign-in in the system browser

The app no longer shows the login page in a web view, where neither Safari's
AutoFill nor the passkeys in the player's iCloud Keychain reach. Signed out,
it shows a native "Got an account?" screen, and either answer opens the sign-in
in an `ASWebAuthenticationSession`. The site's half is described above
`APP_SIGNIN_TTL` in `v2/_lib.php`; in short:

1. The app makes a PKCE pair (RFC 7636, S256) and opens
   `https://empanadas.io/v2/auth/app.php?challenge=<challenge>&mode=login|create`.
2. `app.php` notes the challenge in the browser's session (`app_signin`, for
   `APP_SIGNIN_TTL`, 15 minutes) and sends it to `/v2/login?s=1` (the username
   step) or `/v2/login?create=1` (Pick a Username). A browser already signed in
   is asked "Continue as …?" instead, with "Use Another Account" (or "Create a
   New Account") signing it out through `logout.php` and starting over. The
   code is only minted on that tap, behind the CSRF token.
3. The sign-in runs as on the website. While `app_signin` is waiting,
   `login.php` finishes on `app.php` rather than the dashboard, keeps
   `app_signin` through Switch Accounts, and leaves the site's navigation out;
   `login.js`' `startOauth()` opens the providers in the tab rather than a
   popup (that browser has one tab); and `js.php`, which every sign-in passes
   through (new accounts included), goes back to `app.php` with no roundabout.
4. `app.php` stores a one-time code (`app_signin_codes`,
   `database/app_signin.sql`: SHA-256 of the code, the challenge, the account,
   five minutes) and sends the browser to `empanadas-io://signin?code=<code>`.
5. The app posts the code and the verifier to `/v2/ios/signin.php` with its
   web views' cookies and user agent, as the other `/v2/ios/` requests do:

   ```
   POST /v2/ios/signin.php   code=<code>&verifier=<verifier>
   { "ok": true, "api": 1, "account": { "username": "tester" } }
   ```

   That signs the app's session in as a passkey sign-in does (2FA was asked
   in the browser). Errors: `400 expired` (unknown, used or expired code, or a
   verifier that does not match: the code is spent either way), `403
   deactivated`, `405 wrong_method`, `503 unavailable`.
6. The app then loads `/v2/auth/js.php?r=/v2/dashboard` out of sight, so the
   site's scripts find the account cache in the web views' storage.

The site's `tests/appsignin_e2e.php` runs all of this against a database, and
`tests/iosapp_test.php` the helpers, with RFC 7636's own example (as the app's
`AppSignInTests` does).
