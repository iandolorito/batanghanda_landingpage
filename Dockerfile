FROM php:8.4-apache-bookworm

RUN mv "$PHP_INI_DIR/php.ini-production" "$PHP_INI_DIR/php.ini" \
    && php -r 'exit(extension_loaded("pdo_sqlite") ? 0 : 1);'

WORKDIR /var/www/html
COPY index.html style.css feedback.js robots.txt sitemap.xml ./
COPY assets/ ./assets/
COPY api/ ./api/
COPY docker/apache-security.conf /etc/apache2/conf-enabled/batanghanda-security.conf
COPY docker/start.sh /usr/local/bin/batanghanda-start
RUN chmod +x /usr/local/bin/batanghanda-start \
    && a2dismod mpm_event mpm_worker \
    && a2enmod mpm_prefork \
    && apache2ctl -t

ENV BH_FEEDBACK_DB_PATH=/data/feedback.sqlite
EXPOSE 8080
CMD ["/usr/local/bin/batanghanda-start"]
