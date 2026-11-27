PlayStore 95 · Накопительное обновление

1. На Timeweb сохрани рабочие данные
cd /root/playstore95_code && cp -aL data "/root/playstore95-data-backup-$(date +%Y%m%d-%H%M%S)"

2. В GitHub открой ветку main репозитория sajhankulaev-cloud/playstore95. Загрузи содержимое 01-code рядом с package.json. Папки lib и public объедини с существующими. При загрузке через браузер можно поместить файлы lib/rankings в соответствующую папку отдельной загрузкой. Для публикации одним коммитом удобно использовать GitHub Desktop.

3. Если нужен собранный каталог, сначала сравни файлы на сервере с исходными контрольными суммами из FILES.txt. Для проверки из папки проекта:
sha256sum data/all_games.json data/games.json data/preorders.json data/newreleases.json
При совпадении скопируй содержимое 02-catalog/data в data в репозитории. Используй GitHub Desktop для большого all_games.json. Если каталог менялся на сервере, сохрани ручные изменения и объединяй данные отдельно. Рейтинг Sony и отметки EA Play уже входят в 01-code. Рабочий data/store.json сохраняй.

4. После коммита на GitHub обнови существующий сайт на Timeweb
cd /root/playstore95_code && git pull --ff-only origin main && pm2 restart playstore95 && pm2 status

5. Открой админку /ps95_manage. В разделе «Каталог игр и аддонов» выбери тип позиции. Кнопка «Редактировать» открывает галочки EA Play по регионам. Нажми «Сохранить». Ручные настройки записываются в data/ea-overrides.json и имеют приоритет над импортом. Обычная скидка в регионе скрывает цену EA Play на витрине.

Для локальной проверки распакуй отдельный полный архив, открой папку playstore95-main и выполни npm ci, затем npm start. Открой http://localhost:3000.
