import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import dotenv from 'dotenv';
import Anthropic from '@anthropic-ai/sdk';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: [
    'https://kingdom-wealth-frontend.vercel.app',
    'https://thehealedplace.org',
    'https://www.thehealedplace.org',
    /\.vercel\.app$/,
  ],
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json());

const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100
});
app.use(limiter);

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

app.get('/', (req, res) => {
  res.json({ status: 'Kingdom Wealth Builders API is running! 👑' });
});

app.post('/ai/chat', async (req, res) => {
  try {
    const { messages, system } = req.body;
    if (!messages || !Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages array required' });
    }
    const systemPrompt = system || `You are the Kingdom Wealth Builders AI Coach — a warm, expert, faith-centered financial stewardship coach. Be encouraging, practical, and warm. Give ONE clear actionable next step per response. Format with **bold** for key points.`;
    const response = await client.messages.create({
 model: 'claude-sonnet-4-20250514',


        
