# 国内镜像：DaoCloud 代理 Docker Hub
FROM docker.m.daocloud.io/library/node:20-alpine

RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories

WORKDIR /app
COPY server/package.json ./

RUN npm config set registry https://registry.npmmirror.com \
 && npm install --omit=dev

COPY server/src ./src
COPY server/public ./public
ENV PORT=8083
ENV DATA_DIR=/data
EXPOSE 8083
VOLUME ["/data"]
CMD ["npm", "start"]
