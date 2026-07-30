export interface NumberInfo {
  number: string;
  raw?: string;
  e164?: string;
  country: string;
  source: string;
}

export interface SmsInfo {
  timestamp: string;
  number: string;
  service: string;
  message: string;
  country: string;
  source: string;
  btn1Text?: string;
  btn1Url?: string;
  btn2Text?: string;
  btn2Url?: string;
  btn3Text?: string;
  btn3Url?: string;
  botUsername?: string;
}

export interface BotConfig {
  token: string;
  groupId: string;
  ownerChatId: string;
  botLink?: string;
  otpGroupUrl?: string;
  status?: 'active' | 'offline';
  // Custom Telegram OTP buttons
  btn1Text?: string;
  btn1Url?: string;
  btn2Text?: string;
  btn2Url?: string;
  btn3Text?: string;
  btn3Url?: string;
  // AI Chat Bot (Gemini) — user brings their own API key
  geminiApiKey?: string;
}

export interface Subscriber {
  chatId: number;
  username?: string;
  firstName?: string;
  registeredAt: string;
  numbers?: { number: string; country: string; registeredAt: string; messageId?: number }[];
}

export interface UserAccount {
  id: string;
  username: string;
  email: string;
  password?: string; // Only returned if authenticated or to super-admin
  botConfig: BotConfig;
  subscribers: Subscriber[];
  createdAt?: string;
  expiryDate?: string;
}

export interface PanelStats {
  totalNumbers: number;
  countryBreakdown: { [key: string]: number };
}
