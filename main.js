import { google } from 'googleapis';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BASE_URL = 'https://ozone-idp-brands-im-kba.swiggy.com/v1/accounts';
const CLIENT_ID = 'f4e72b9a-5fde-4d1a-9e74-0237bcf4d67f';
const EMAIL = 'platforms@moxiebeauty.in';
const CREDENTIALS_PATH = path.join(__dirname, 'gmail-credentials.json');
const TOKEN_PATH = path.join(__dirname, 'gmail-token.json');
const OTP_SUBJECT = 'Your Login OTP for Swiggy Instamart Ads Portal';

const getHeaders = () => ({
  accept: '*/*',
  'accept-language': 'en-GB,en-US;q=0.9,en;q=0.8',
  app_version: '1.4.67',
  'content-type': 'application/json',
  origin: 'https://partner.swiggy.com',
  priority: 'u=1, i',
  referer: 'https://partner.swiggy.com/',
  'sec-ch-ua': '"Google Chrome";v="141", "Not?A_Brand";v="8", "Chromium";v="141"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-site',
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
  'x-client-request-id': uuidv4(),
  'x-timestamp': Date.now().toString(),
});

function loadCredentials() {
  try {
    const credentials = JSON.parse(fsSync.readFileSync(CREDENTIALS_PATH, 'utf-8'));
    const token = JSON.parse(fsSync.readFileSync(TOKEN_PATH, 'utf-8'));
    return { credentials, token };
  } catch (error) {
    console.error('Error loading credentials:', error.message);
    throw error;
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

function extractOTP(emailBody) {
  const otpPattern = /Your OTP for logging into the Swiggy Instamart Ads Portal is:\s*(\d{6})/i;
  const match = emailBody.match(otpPattern);
  
  if (match && match[1]) {
    return match[1];
  }
  
  const digitPattern = /\b(\d{6})\b/;
  const digitMatch = emailBody.match(digitPattern);
  
  return digitMatch ? digitMatch[1] : null;
}

function decodeEmailBody(encodedBody) {
  if (!encodedBody) return '';
  
  const base64 = encodedBody.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(base64, 'base64').toString('utf-8');
}

function getEmailBody(payload) {
  let body = '';
  
  if (payload.body && payload.body.data) {
    body = decodeEmailBody(payload.body.data);
  } else if (payload.parts) {
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain' || part.mimeType === 'text/html') {
        if (part.body && part.body.data) {
          body += decodeEmailBody(part.body.data);
        }
      }
      
      if (part.parts) {
        for (const nestedPart of part.parts) {
          if (nestedPart.body && nestedPart.body.data) {
            body += decodeEmailBody(nestedPart.body.data);
          }
        }
      }
    }
  }
  
  return body;
}

async function fetchOTP() {
  try {
    console.log('Loading Gmail credentials...');
    const { credentials, token } = loadCredentials();
    
    console.log('Creating OAuth2 client...');
    const auth = createOAuth2Client(credentials, token);
    
    console.log('Initializing Gmail API...');
    const gmail = google.gmail({ version: 'v1', auth });
    
    const twoMinutesAgo = Math.floor(Date.now() / 1000) - (2 * 60);
    const query = `subject:"${OTP_SUBJECT}" after:${twoMinutesAgo}`;
    
    console.log(`Searching for emails with subject: "${OTP_SUBJECT}"`);
    console.log(`Time filter: Last 2 minutes (after ${new Date(twoMinutesAgo * 1000).toISOString()})`);
    
    const listResponse = await gmail.users.messages.list({
      userId: 'me',
      q: query,
      maxResults: 5,
    });
    
    const messages = listResponse.data.messages;
    
    if (!messages || messages.length === 0) {
      console.log('No OTP emails found in the last 2 minutes');
      return null;
    }
    
    console.log(`Found ${messages.length} email(s)`);
    
    const messageId = messages[0].id;
    console.log(`Fetching message ID: ${messageId}`);
    
    const messageResponse = await gmail.users.messages.get({
      userId: 'me',
      id: messageId,
      format: 'full',
    });
    
    const message = messageResponse.data;
    const payload = message.payload;
    
    const headers = payload.headers;
    const subjectHeader = headers.find(h => h.name.toLowerCase() === 'subject');
    const dateHeader = headers.find(h => h.name.toLowerCase() === 'date');
    
    console.log(`Subject: ${subjectHeader?.value}`);
    console.log(`Received: ${dateHeader?.value}`);
    
    const emailBody = getEmailBody(payload);
    
    if (!emailBody) {
      console.log('Could not extract email body');
      return null;
    }
    
    const otp = extractOTP(emailBody);
    
    if (otp) {
      console.log(`OTP Found: ${otp}`);
      return otp;
    } else {
      console.log('Could not extract OTP from email body');
      console.log('Email body preview:');
      console.log(emailBody.substring(0, 500));
      return null;
    }
    
  } catch (error) {
    console.error('Error fetching OTP:', error.message);
    
    if (error.message.includes('invalid_grant') || error.message.includes('Token has been expired')) {
      console.error('Access token has expired. Please refresh the token.');
    }
    
    throw error;
  }
}

async function sendVerificationCode(email) {
  console.log('\n=== Step 1: Sending verification code ===');
  console.log(`Email: ${email}`);

  try {
    const response = await fetch(`${BASE_URL}/sendVerificationCode`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        email,
        client_id: CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to send verification code: ${response.status} ${response.statusText}\n${errorText}`
      );
    }

    const data = await response.json();
    console.log('Verification code request successful');
    console.log('Response:', JSON.stringify(data, null, 2));

    if (!data.user_id || !data.session_info) {
      throw new Error('Missing user_id or session_info in response');
    }

    return {
      user_id: data.user_id,
      session_info: data.session_info,
    };
  } catch (error) {
    console.error('Error sending verification code:', error.message);
    throw error;
  }
}

async function waitAndFetchOTP(maxAttempts = 6, delaySeconds = 10, initialWaitSeconds = 20) {
  console.log('\n=== Step 2: Waiting for OTP email ===');
  console.log(`Waiting ${initialWaitSeconds} seconds before first Gmail fetch attempt...`);

  const waitStartTime = Date.now();
  await new Promise((resolve) => setTimeout(resolve, initialWaitSeconds * 1000));
  const waitEndTime = Date.now();
  const actualWaitSeconds = ((waitEndTime - waitStartTime) / 1000).toFixed(2);
  
  console.log(`Initial wait completed. Actual wait time: ${actualWaitSeconds} seconds`);
  console.log('Starting OTP checks...');

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.log(`\nAttempt ${attempt}/${maxAttempts}: Checking for OTP...`);

    try {
      const otp = await fetchOTP();

      if (otp) {
        console.log(`OTP successfully retrieved: ${otp}`);
        return otp;
      } else {
        console.log('No OTP found in this attempt.');
      }
    } catch (error) {
      console.log(`Error fetching OTP on attempt ${attempt}: ${error.message}`);
    }

    if (attempt < maxAttempts) {
      console.log(`Waiting ${delaySeconds} seconds before next attempt...`);
      await new Promise((resolve) => setTimeout(resolve, delaySeconds * 1000));
    }
  }

  throw new Error('Failed to fetch OTP after maximum attempts');
}

async function signInWithOTP(otp, userId, sessionInfo) {
  console.log('\n=== Step 3: Signing in with OTP ===');
  console.log(`Using OTP: ${otp}`);

  try {
    const response = await fetch(`${BASE_URL}/signInWithOTP`, {
      method: 'POST',
      headers: getHeaders(),
      body: JSON.stringify({
        otp,
        user_id: userId,
        session_info: sessionInfo,
        client_id: CLIENT_ID,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to sign in: ${response.status} ${response.statusText}\n${errorText}`);
    }

    const data = await response.json();
    console.log('Sign-in successful');
    console.log('Response:', JSON.stringify(data, null, 2));
    return data;
  } catch (error) {
    console.error('Error signing in with OTP:', error.message);
    throw error;
  }
}

async function saveTokensToFile(authResponse) {
  console.log('\n=== Step 4: Saving tokens to file ===');
  try {
    const tokenData = {
      access_token: authResponse.access_token,
      refresh_token: authResponse.refresh_token,
      saved_at: new Date().toISOString(),
    };

    const filePath = path.join(process.cwd(), 'instamart-token.json');
    console.log(`Writing tokens to file: ${filePath}`);

    await fs.writeFile(filePath, JSON.stringify(tokenData, null, 2), 'utf8');

    const check = await fs.readFile(filePath, 'utf8');
    console.log('File written successfully. File content preview:');
    console.log(check);
  } catch (error) {
    console.error('Error saving tokens to file:', error.message);
    throw error;
  }
}

async function authenticateWithOTP(email = EMAIL) {
  console.log('\n==============================');
  console.log('Swiggy Instamart Authentication Flow Started');
  console.log('==============================');

  try {
    const { user_id, session_info } = await sendVerificationCode(email);
    const otp = await waitAndFetchOTP();
    const authResponse = await signInWithOTP(otp, user_id, session_info);

    if (authResponse.access_token && authResponse.refresh_token) {
      await saveTokensToFile(authResponse);
      console.log('\nAuthentication completed successfully.');
    } else {
      console.log('Warning: Missing access_token or refresh_token in response');
    }

    return authResponse;
  } catch (error) {
    console.error('\nAuthentication failed:', error.message);
    throw error;
  }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  (async () => {
    try {
      const email = process.argv[2] || EMAIL;
      const result = await authenticateWithOTP(email);
      process.exit(0);
    } catch (error) {
      console.error('\nFatal error:', error.message);
      process.exit(1);
    }
  })();
}

export {
  sendVerificationCode,
  waitAndFetchOTP,
  signInWithOTP,
  saveTokensToFile,
  authenticateWithOTP,
  fetchOTP,
};
