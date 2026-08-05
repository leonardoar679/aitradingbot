import express from 'express'
import { healthRouter } from './routes/health.js'

const app = express()
const port = process.env.PORT ? Number(process.env.PORT) : 4000

app.use(express.json())
app.use('/health', healthRouter)

app.listen(port, () => {
  console.log(`backend listening on http://localhost:${port}`)
})
