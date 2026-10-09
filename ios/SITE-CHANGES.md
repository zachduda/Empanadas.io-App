# Site changes the iOS app needs

The iOS app is a native shell around empanadas.io, so part of the work is on
the site (the `zachduda/Empanadas-io` repo). Everything below refers to files
under `html/` there.

## Status

Done in zachduda/Empanadas-io#70: sections 1, 2, 3 and 5, the dashboard part
of section 4, and the coffee links in section 6. The app itself hides the
navbar (`Resources/bridge.js`), since `getNav()` lives in config.php, which is
not in that repo.

Still to do:

- **Sign in with Apple** (section 6). The Apple provider in
  `v2/auth/flow.php` is commented out and needs its key on the server.
- **Passkeys** (section 7). This needs the apple-app-site-association file,
  which contains the Team ID.
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

For passkeys created on empanadas.io to work in the app's web views, serve
this at `https://empanadas.io/.well-known/apple-app-site-association`
(`Content-Type: application/json`, no redirect). Replace `TEAMID` with the
Apple Developer Team ID:

```json
{
  "webcredentials": {
    "apps": ["TEAMID.io.empanadas.app"]
  }
}
```

The app already has the matching `webcredentials:empanadas.io` entitlement.
