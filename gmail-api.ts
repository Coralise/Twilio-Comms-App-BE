const fs = require('fs').promises;
const path = require('path');
const {authenticate} = require('@google-cloud/local-auth');
const {google} = require('googleapis');

// If modifying these scopes, delete token.json.
const SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'];
// The file token.json stores the user's access and refresh tokens, and is
// created automatically when the authorization flow completes for the first
// time.
const TOKEN_PATH = path.join(process.cwd(), 'token.json');
const CREDENTIALS_PATH = path.join(process.cwd(), 'credentials.json');

/**
 * Reads previously authorized credentials from the save file.
 *
 * @return {Promise<OAuth2Client|null>}
 */
async function loadSavedCredentialsIfExist() {
  try {
    const content = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(content);
    return google.auth.fromJSON(credentials);
  } catch (err) {
    return null;
  }
}

/**
 * Serializes credentials to a file compatible with GoogleAuth.fromJSON.
 *
 * @param {OAuth2Client} client
 * @return {Promise<void>}
 */
async function saveCredentials(client: { credentials: { refresh_token: any; }; }) {
  const content = await fs.readFile(CREDENTIALS_PATH);
  const keys = JSON.parse(content);
  const key = keys.installed || keys.web;
  const payload = JSON.stringify({
    type: 'authorized_user',
    client_id: key.client_id,
    client_secret: key.client_secret,
    refresh_token: client.credentials.refresh_token,
  });
  await fs.writeFile(TOKEN_PATH, payload);
}

/**
 * Load or request or authorization to call APIs.
 *
 */
export async function authorize() {
  let client = await loadSavedCredentialsIfExist();
  if (client) {
    return client;
  }
  client = await authenticate({
    scopes: SCOPES,
    keyfilePath: CREDENTIALS_PATH,
  });
  if (client.credentials) {
    await saveCredentials(client);
  }
  return client;
}

/**
 * Lists the labels in the user's account.
 *
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 */
async function listLabels(auth: any) {
  const gmail = google.gmail({version: 'v1', auth});
  const res = await gmail.users.labels.list({
    userId: 'me',
  });
  const labels = res.data.labels;
  if (!labels || labels.length === 0) {
    console.log('No labels found.');
    return;
  }
  console.log('Labels:');
  labels.forEach((label: { name: any; }) => {
    console.log(`- ${label.name}`);
  });
}

interface Email {
    from: string;
    cc?: string;
    bcc?: string;
    subject: string;
    date: string;
    body: string;
    attachments: {
        filename: string;
        filePath: string;
    }[];
}

/**
 * Gets the emails received after a specific date.
 *
 * @param {google.auth.OAuth2} auth An authorized OAuth2 client.
 * @param {string} date The date in RFC 3339 format (e.g., '2025-01-17T00:00:00Z').
 */
export async function getEmailsAfterDate(auth: any, date: string): Promise<Email[] | null> {
  const gmail = google.gmail({version: 'v1', auth});
  const res = await gmail.users.messages.list({
    userId: 'me',
    q: `after:${new Date(date).getTime() / 1000}`,
  });
  const messages = res.data.messages;
  if (!messages || messages.length === 0) {
    console.log('No messages found.');
    return [];
  }
  const emails: Email[] = [];
  for (const message of messages) {
    const msg = await gmail.users.messages.get({
      userId: 'me',
      id: message.id,
    });
    const headers = msg.data.payload.headers;
    const email = {
      from: headers.find((header: { name: string; }) => header.name === 'From')?.value,
      cc: headers.find((header: { name: string; }) => header.name === 'Cc')?.value,
      bcc: headers.find((header: { name: string; }) => header.name === 'Bcc')?.value,
      subject: headers.find((header: { name: string; }) => header.name === 'Subject')?.value,
      date: headers.find((header: { name: string; }) => header.name === 'Date')?.value,
      body: msg.data.snippet,
      attachments: await Promise.all(
        msg.data.payload.parts?.filter((part: { filename?: string; }) => part.filename).map(async (part: { filename?: string; body: { attachmentId: string; }; }) => {
          const attachmentRes = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${message.id}/attachments/${part.body.attachmentId}`, {
            headers: {
              Authorization: `Bearer ${auth.credentials.access_token}`,
            },
          });
          const attachmentData = await attachmentRes.json();
          const buffer = Buffer.from(attachmentData.data, 'base64');
          const filePath = path.join(process.cwd(), 'uploads', part.filename);
          await fs.writeFile(filePath, buffer);

          const url = `http://localhost:3001/uploads/${part.filename}`;

          console.log(url)
          
          return { filename: part.filename, url };
        }) || []
      ),
    };
    emails.push(email);
  }
  return emails;
}