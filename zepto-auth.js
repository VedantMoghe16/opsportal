const { google } = require('googleapis');
const fs = require('fs').promises;
const fsSync = require('fs');
const path = require('path');
require('dotenv').config();

// Zepto auth
const ZEPTO_EMAIL = process.env.ZEPTO_EMAIL;
const ZEPTO_PASSWORD = process.env.ZEPTO_PASSWORD; 
const APPLICATION_ID = '59b80e60-05bd-45c2-a334-d5ae76c2bb32';

const SIGN_IN_URL = `https://cx.zepto.co.in/api/v1/auth/sign-in?applicationId=${APPLICATION_ID}`;
const VALIDATE_OTP_URL = 'https://cx.zepto.co.in/api/v1/auth/validate-mfa-otp/';

// Gmail config (adjust once you see the real Zepto OTP email)
const CREDENTIALS_PATH = path.join(__dirname, 'gmail-credentials.json');
const TOKEN_PATH = path.join(__dirname, 'gmail-token.json');

const OTP_FROM = 'mailer@zeptonow.com';      
const OTP_SUBJECT_CONTAINS = 'Email Otp';            
const OTP_LOOKBACK_MIN = 5;                
const OTP_DIGIT_LENGTH = 4;                   

const TOKEN_OUTPUT_PATH = path.join(__dirname, 'zepto-token.json');

// Node 20 has global fetch; just sanity-check
if (typeof fetch !== 'function') {
  throw new Error('This script requires Node 18+ with global fetch.');
}


function loadGmailCredentials() {
  try {
    const credentials = JSON.parse(fsSync.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    const token = JSON.parse(fsSync.readFileSync(TOKEN_PATH, 'utf-8'));
    return { credentials, token };
  } catch (err) {
    console.error('Error loading Gmail credentials:', err.message);
    throw err;
  }
}

function createOAuth2Client(credentials, token) {
  const { client_id, client_secret, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(
    client_id,
    client_secret,
    redirect_uris[0]
  );
  oAuth2Client.setCredentials(token);
  return oAuth2Client;
}

async function getGmailClient() {
  console.log('📨 Initializing Gmail client...');
  const { credentials, token } = loadGmailCredentials();
  const auth = createOAuth2Client(credentials, token);
  return google.gmail({ version: 'v1', auth });
}

function buildOtpQuery() {
  const nowSeconds = Math.floor(Date.now() / 1000);
  const afterSeconds = nowSeconds - OTP_LOOKBACK_MIN * 60;
  const parts = [];

  if (OTP_FROM) parts.push(`from:${OTP_FROM}`);
  if (OTP_SUBJECT_CONTAINS) parts.push(`subject:${OTP_SUBJECT_CONTAINS}`);
  parts.push(`after:${afterSeconds}`);

  const q = parts.join(' ');
  console.log('🔍 Gmail OTP search query:', q);
  return q;
}

function collectBodies(payload, result = []) {
  if (!payload) return result;

  console.log(payload.body);
  if (payload.body && payload.body.data) {
    const decoded = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    result.push(decoded);
  }

  if (payload.parts && payload.parts.length) {
    for (const part of payload.parts) {
      collectBodies(part, result);
    }
  }

  return result;
}

function extractOtpFromText(text) {
  if (!text) return null;
  // Match 4-6 digit number; you can tighten to exactly 4 if you want
  const regex =
    OTP_DIGIT_LENGTH === 4
      ? /\b(\d{4})\b/
      : /\b(\d{4,6})\b/;
  const match = text.match(regex);
  return match ? match[1] : null;
}

async function fetchLatestOtpFromGmail() {
  const gmail = await getGmailClient();
  const q = buildOtpQuery();

  const listRes = await gmail.users.messages.list({
    userId: 'me',
    q,
    maxResults: 5,
  });

  const messages = listRes.data.messages || [];
  if (!messages.length) {
    throw new Error('No OTP emails found for Zepto within lookback window');
  }

  const messageId = messages[0].id;
  console.log('📨 Using Gmail message ID:', messageId);

  const fullRes = await gmail.users.messages.get({
    userId: 'me',
    id: messageId,
    format: 'full',
  });

  const message = fullRes.data;
  const headers = message.payload.headers || [];
  const subjectHeader = headers.find((h) => h.name.toLowerCase() === 'subject');
  const dateHeader = headers.find((h) => h.name.toLowerCase() === 'date');
  console.log('   Subject:', subjectHeader?.value || '(none)');
  console.log('   Date   :', dateHeader?.value || '(none)');

  const bodies = collectBodies(message.payload);
  const combinedText = bodies.join('\n');

  const otp = extractOtpFromText(combinedText);
  if (!otp) {
    console.log('Email body preview:\n', combinedText.slice(0, 500));
    throw new Error('OTP not found in Zepto email body');
  }

  console.log(`✅ Extracted OTP from Gmail: ${otp}`);
  return otp;
}

async function waitForZeptoOtp(maxAttempts = 5, delaySeconds = 6) {
  console.log('\n=== Waiting for Zepto OTP email ===');
  for (let i = 1; i <= maxAttempts; i++) {
    console.log(`Attempt ${i}/${maxAttempts}...`);
    try {
      const otp = await fetchLatestOtpFromGmail();
      return otp;
    } catch (err) {
      console.log('   Not yet:', err.message);
      if (i < maxAttempts) {
        await new Promise((res) => setTimeout(res, delaySeconds * 1000));
      }
    }
  }
  throw new Error('Failed to fetch Zepto OTP from Gmail after max attempts');
}


function buildCommonHeaders() {
  return {
    accept: 'application/json, text/plain, */*',
    'accept-language': 'en-US,en;q=0.9,hi;q=0.8',
    'content-type': 'application/json',
    origin: 'https://partner.zepto.co.in',
    referer: 'https://partner.zepto.co.in/',
    'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-site',
    'user-agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  };
}

async function zeptoSignIn() {
  console.log('\n=== Step 1: Zepto sign-in (email+password) ===');
  if (!ZEPTO_PASSWORD) {
    throw new Error('ZEPTO_PASSWORD is empty. Set it via environment variable.');
  }

  const res = await fetch(SIGN_IN_URL, {
    method: 'POST',
    headers: buildCommonHeaders(),
    body: JSON.stringify({
      email: ZEPTO_EMAIL,
      password: ZEPTO_PASSWORD,
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error('Raw sign-in response:', text);
    throw new Error(`Zepto sign-in returned non-JSON (status ${res.status})`);
  }

  if (!res.ok) {
    console.error('Sign-in error response:', data);
    throw new Error(
      `Zepto sign-in failed: ${res.status} ${res.statusText} - ${JSON.stringify(data)}`
    );
  }

  console.log('Sign-in response:', JSON.stringify(data, null, 2));

  // You may need to tweak this field based on actual response shape
  const mfaId = data.mfaId || data.data?.mfaId || data.result?.mfaId;
  if (!mfaId) {
    throw new Error('mfaId not found in Zepto sign-in response. Inspect above JSON.');
  }

  console.log('✅ Got mfaId:', mfaId);
  return mfaId;
}

async function zeptoValidateOtp(mfaId, otp) {
  console.log('\n=== Step 3: Validate Zepto OTP ===');
  console.log('Using mfaId:', mfaId);
  console.log('Using otp  :', otp);

  const res = await fetch(VALIDATE_OTP_URL, {
    method: 'POST',
    headers: buildCommonHeaders(),
    body: JSON.stringify({
      otp,
      mfaId,
      applicationId: APPLICATION_ID,
    }),
  });

  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    console.error('Raw validate-otp response:', text);
    throw new Error(`Zepto validate OTP returned non-JSON (status ${res.status})`);
  }

  if (!res.ok) {
    console.error('Validate-OTP error response:', data);
    throw new Error(
      `Zepto validate OTP failed: ${res.status} ${res.statusText} - ${JSON.stringify(data)}`
    );
  }

  console.log('Validate-OTP response:', JSON.stringify(data, null, 2));

  // We don't know exact structure yet, so we store full data.
  return data;
}

  // Try to guess likely token fields
async function saveZeptoTokens(authResponse) {
  console.log('\n=== Step 4: Saving Zepto tokens ===');

  const tokenBundle = {
    email: authResponse.email,
    tokenType: authResponse.tokenType,        // "Bearer"
    jwtToken: authResponse.jwtToken,          // main token you’ll use
    redirectUrl: authResponse.redirectUrl,
    userId: authResponse.userId,
    fullName: authResponse.fullName,
    contact: authResponse.contact,
    tags: authResponse.tags,
    saved_at: new Date().toISOString(),
  };

  await fs.writeFile(TOKEN_OUTPUT_PATH, JSON.stringify(tokenBundle, null, 2), 'utf8');

  console.log(`✅ Zepto auth data saved to: ${TOKEN_OUTPUT_PATH}`);
}

// ---------------------- MAIN FLOW ----------------------

async function main() {
  try {
    console.log('╔════════════════════════════════════════╗');
    console.log('║        Zepto Login via Gmail OTP       ║');
    console.log('╚════════════════════════════════════════╝\n');

    console.log('Email:', ZEPTO_EMAIL);

    // 1) Email+password sign in -> mfaId
    const mfaId = await zeptoSignIn();

    // 2) Wait for OTP in Gmail
    await new Promise((resolve) => setTimeout(resolve, 3000));
    const otp = await waitForZeptoOtp();

    // 3) Validate OTP
    const authResponse = await zeptoValidateOtp(mfaId, otp);

    // 4) Save tokens / raw response
    await saveZeptoTokens(authResponse);

    console.log('\n🎉 Zepto authentication flow completed successfully.\n');
    process.exit(0);
  } catch (err) {
    console.error('\n❌ Error in Zepto auth flow:', err.message);
    console.error(err.stack);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

