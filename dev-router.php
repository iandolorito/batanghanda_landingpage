<?php
declare(strict_types=1);

// The PHP development server ignores .htaccess. Protect private files explicitly.
$path = rawurldecode(parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/');
if (strpos($path, "\0") !== false
    || strpos($path, '\\') !== false
    || preg_match('~(?:^|/)(?:\.[^/]*|storage|tests|docker|dev-router\.php)(?:/|$)~i', $path)) {
    http_response_code(404);
    exit('Not found');
}
return false;
