import json from 'body-parser'
import dotenv from 'dotenv'
import express from 'express'
import TelegramBot from 'node-telegram-bot-api'
import { open } from 'sqlite'
import Database from 'sqlite3'
dotenv.config()

// === Переменные окружения ===
const BOT_TOKEN = process.env.BOT_TOKEN
const ADMIN_ID = process.env.ADMIN_ID
const ADMIN_KEY = process.env.ADMIN_KEY
const PORT = process.env.PORT || 3000
const HOSTNAME = (process.env.HOSTNAME || '').replace(/\/$/, '') // удаляем слэш на конце

if (!/^https?:\/\//.test(HOSTNAME)) {
	console.error('❌ HOSTNAME должен начинаться с http:// или https://')
	process.exit(1)
}

if (!BOT_TOKEN) {
	console.error('❌ BOT_TOKEN обязателен!')
	process.exit(1)
}

const bot = new TelegramBot(BOT_TOKEN, { polling: true })
const app = express()
app.use(json())

let db

// === Инициализация базы ===
async function initDb() {
	db = await open({
		filename: './data.db',
		driver: Database,
	})

	await db.exec(`
        CREATE TABLE IF NOT EXISTS offers (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            url TEXT NOT NULL
        );
    `)

	await db.exec(`
        CREATE TABLE IF NOT EXISTS users (
            tg_id TEXT PRIMARY KEY,
            offer_id INTEGER,
            first_seen DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(offer_id) REFERENCES offers(id)
        );
    `)

	await db.exec(`
        CREATE TABLE IF NOT EXISTS clicks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            tg_id TEXT,
            offer_id INTEGER,
            ts DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY(tg_id) REFERENCES users(tg_id),
            FOREIGN KEY(offer_id) REFERENCES offers(id)
        );
    `)

	// Заполняем офферы
	const count = await db.get('SELECT COUNT(*) as c FROM offers')
	if (count.c === 0) {
		const links = (process.env.REF_LINKS || '')
			.split(',')
			.map(l => l.trim())
			.filter(Boolean)

		if (links.length === 0) {
			console.warn('⚠️ REF_LINKS пуст — добавляем тестовую ссылку')
			links.push('https://example.com/test-offer')
		}

		for (const url of links) {
			await db.run('INSERT INTO offers (url) VALUES (?)', url)
		}
		console.log(`✅ Добавлено ${links.length} офферов`)
	}
}

// === Логика выдачи оффера ===
async function getOfferForUser(tgId) {
	const user = await db.get('SELECT * FROM users WHERE tg_id = ?', tgId)
	if (user) {
		return await db.get('SELECT * FROM offers WHERE id = ?', user.offer_id)
	}

	const userCount = await db.get('SELECT COUNT(*) as c FROM users')
	const offers = await db.all('SELECT * FROM offers ORDER BY id ASC')
	if (offers.length === 0) return null

	const idx = userCount.c % offers.length
	const offer = offers[idx]

	await db.run(
		'INSERT INTO users (tg_id, offer_id) VALUES (?, ?)',
		tgId,
		offer.id
	)
	return offer
}

async function logClick(tgId, offerId) {
	await db.run(
		'INSERT INTO clicks (tg_id, offer_id) VALUES (?, ?)',
		tgId,
		offerId
	)
}

// === Команда /start ===
bot.onText(/\/start/, async msg => {
	const chatId = msg.chat.id
	const offer = await getOfferForUser(chatId)

	if (!offer) {
		return bot.sendMessage(
			chatId,
			'❌ Сейчас нет доступных предложений. Загляни позже.'
		)
	}

	const url = `${HOSTNAME}/r/${offer.id}?u=${chatId}`
	const keyboard = {
		reply_markup: {
			inline_keyboard: [[{ text: '🔥 Получить бонус', url }]],
		},
	}

	await bot.sendMessage(
		chatId,
		`👋 Привет! У нас для тебя есть эксклюзивное предложение.\n\nНажми кнопку ниже и забери свой бонус прямо сейчас:`,
		keyboard
	)
})

// === Админ статистика ===
bot.onText(/\/stats (.+)/, async (msg, match) => {
	const from = msg.from.id
	if (!ADMIN_ID || String(from) !== String(ADMIN_ID)) {
		return bot.sendMessage(from, '⛔ Доступ запрещён.')
	}
	if (!match[1] || match[1] !== ADMIN_KEY) {
		return bot.sendMessage(from, '❌ Неверный ключ администратора.')
	}

	const totalUsers = await db.get('SELECT COUNT(*) as c FROM users')
	const totalClicks = await db.get('SELECT COUNT(*) as c FROM clicks')
	const clicksPerOffer = await db.all(`
        SELECT offers.url, COUNT(clicks.id) as clicks
        FROM offers
        LEFT JOIN clicks ON offers.id = clicks.offer_id
        GROUP BY offers.id
    `)

	let text = `📊 Статистика:\n\n👥 Пользователей: ${totalUsers.c}\n🖱 Клики: ${totalClicks.c}\n\n`
	clicksPerOffer.forEach((row, i) => {
		text += `${i + 1}) ${row.url} — ${row.clicks} кликов\n`
	})

	return bot.sendMessage(from, text)
})

// === Редирект по офферу ===
app.get('/r/:offerId', async (req, res) => {
	const offerId = parseInt(req.params.offerId, 10)
	const tgId = req.query.u || 'unknown'

	const offer = await db.get('SELECT * FROM offers WHERE id = ?', offerId)
	if (!offer) return res.status(404).send('Offer not found')

	await logClick(tgId, offerId)

	let targetUrl = offer.url
	const sep = targetUrl.includes('?') ? '&' : '?'
	targetUrl += `${sep}subid=${encodeURIComponent(tgId)}`

	res.redirect(targetUrl)
})

// === Запуск ===
;(async () => {
	await initDb()
	app.listen(PORT, () => console.log(`🌐 Сервер запущен на порту ${PORT}`))
	console.log('🤖 Telegram-бот запущен')
})()
