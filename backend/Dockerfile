# 国内镜像：DaoCloud 代理 Docker Hub（可改成你司私有仓库）
FROM docker.m.daocloud.io/library/node:20-alpine

# Alpine apk 国内源
RUN sed -i 's/dl-cdn.alpinelinux.org/mirrors.aliyun.com/g' /etc/apk/repositories

WORKDIR /app
COPY package.json ./

# npm 淘宝/npmmirror
RUN npm config set registry https://registry.npmmirror.com \
 && npm install --omit=dev

COPY src ./src
ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
