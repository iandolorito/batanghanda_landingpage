#!/bin/sh
set -eu

port="${PORT:-8080}"
case "$port" in
  ''|*[!0-9]*) echo 'PORT must be a valid port number.' >&2; exit 1 ;;
esac
if [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
  echo 'PORT must be between 1 and 65535.' >&2
  exit 1
fi

# Railway mounts volumes at runtime, after the image has been built.
mkdir -p /data
chown www-data:www-data /data
chmod 750 /data
sed -i "s/^Listen 80$/Listen $port/" /etc/apache2/ports.conf
sed -i "s/<VirtualHost \*:80>/<VirtualHost *:$port>/" /etc/apache2/sites-available/000-default.conf

exec apache2-foreground
