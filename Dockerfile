# База уже с Playwright + Chromium и всеми системными зависимостями
FROM mcr.microsoft.com/playwright:v1.49.0-jammy

# Рабочая папка внутри контейнера
WORKDIR /app

# Сначала только package.json/lock — для кэширования слоёв
COPY package*.json ./

# Устанавливаем зависимости (без dev)
# Если нет package-lock.json, npm сам выполнит обычный install
RUN npm install --omit=dev
RUN npx playwright install chromium
# Копируем остальной код
COPY . .

# Прод окружение и порт
ENV NODE_ENV=production
ENV PORT=3000

# Экспонируем порт
EXPOSE 3000

# Старт
CMD ["npm","start"]
