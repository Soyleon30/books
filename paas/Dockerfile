# 国内：DaoCloud 代理 Docker Hub library/node（常用且能拉到官方 node:20-alpine）
FROM docker.m.daocloud.io/library/node:20-alpine

# 构建时打印，方便看卡在哪
RUN echo "==> base image ok" \
 && echo "==> switch apk to aliyun" \
 && sed -i 's#https\?://dl-cdn.alpinelinux.org/alpine#https://mirrors.aliyun.com/alpine#g' /etc/apk/repositories \
 && cat /etc/apk/repositories \
 && echo "==> apk update" \
 && apk update \
 && echo "==> apk add packages" \
 && apk add --no-cache docker-cli unzip tar gzip curl bash python3 \
 && echo "==> apk done" \
 && node -v && npm -v

WORKDIR /app
COPY server/package.json ./

RUN echo "==> npm install (npmmirror)" \
 && npm config set registry https://registry.npmmirror.com \
 && npm config set fetch-retries 5 \
 && npm install --omit=dev --loglevel=info \
 && echo "==> npm done"

COPY server/src ./src
COPY server/public ./public

ENV PORT=8083
ENV DATA_DIR=/data
ENV DOCKER_HOST=unix:///var/run/docker.sock
ENV CONTAINER_RUNTIME=docker

EXPOSE 8083
VOLUME ["/data"]
CMD ["node", "src/index.js"]
