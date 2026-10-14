# 国内镜像：DaoCloud 代理 Docker Hub
FROM docker.m.daocloud.io/library/nginx:1.27-alpine

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories \
 && apk add --no-cache gettext

COPY nginx.conf.template /etc/nginx/templates/default.conf.template
COPY docker-entrypoint.sh /docker-entrypoint.sh
RUN chmod +x /docker-entrypoint.sh
COPY vendor /usr/share/nginx/html/vendor
COPY index.html /usr/share/nginx/html/index.html
ENV API_UPSTREAM=backend:3000
EXPOSE 80
ENTRYPOINT ["/docker-entrypoint.sh"]
