const cors = require('cors');
const nodemailer = require('nodemailer');
const imap = require('imap');
require('dotenv').config();
import twilio from "twilio";
import express, { Request, Response } from "express";
import bodyParser from 'body-parser';
import { ParticipantInstance } from "twilio/lib/rest/conversations/v1/service/conversation/participant";
import multer, { Multer, StorageEngine } from "multer";
import path from 'path';
import { authorize, getEmailsAfterDate } from './gmail-api';

type DestinationCallback = (error: Error | null, destination: string) => void
type FileNameCallback = (error: Error | null, filename: string) => void

const app = express();
const port = process.env.PORT ?? 3001;

app.use(cors());
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

const serviceSid = process.env.TWILIO_CHAT_SERVICE_SID!;

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const AccessToken = twilio.jwt.AccessToken;
const ChatGrant = AccessToken.ChatGrant;

// Set up Multer to handle file uploads
const storage: StorageEngine = multer.diskStorage({
    destination: (
        request: Request,
        file: Express.Multer.File,
        cb: DestinationCallback
    ): void => {
      cb(null, 'uploads/'); // Store files in the 'uploads' folder
    },
    filename: (
        req: Request, 
        file: Express.Multer.File, 
        cb: FileNameCallback
    ): void => {
      cb(null, `${Date.now()}-${file.originalname}`);
    },
  });
const upload: Multer = multer({ storage: storage });

// Gmail SMTP Transporter
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_SMTP_EMAIL,  // Your Gmail address
      pass: process.env.GMAIL_SMTP_APP_PASSWORD,     // Your Gmail App Password
    },
  });

// Set up IMAP connection
const imapConfig = {
    user: process.env.SENDGRID_EMAIL,
    password: process.env.GMAIL_SMTP_APP_PASSWORD,
    host: 'imap.gmail.com',
    port: 993,
    tls: true,
    tlsOptions: {
        rejectUnauthorized: false
    }
};

app.post('/token', (req: Request, res: Response) => {
    console.log("Generating new token...");
    const identity = req.body.identity;

    const token = generateToken(identity);

    res.send({
        token: token.toJwt(),
    });
});

function generateToken(identity: any) {
    const token = new AccessToken(
        process.env.TWILIO_ACCOUNT_SID!,
        process.env.TWILIO_API_KEY_SID!,
        process.env.TWILIO_API_KEY_SECRET!,
        { identity: identity }
    );

    const chatGrant = new ChatGrant({
        serviceSid: serviceSid,
    });
    const voiceGrant = new VoiceGrant({
        outgoingApplicationSid: process.env.TWILIO_TWIML_APP_SID,
        incomingAllow: true // Allow incoming calls
        
    });
    token.addGrant(chatGrant);
    token.addGrant(voiceGrant);
    return token;
}

// Endpoint to create a new conversation
app.post('/create-conversation', async (req, res) => {
    try {
        const { friendlyName } = req.body;

        const conversation = await client.conversations.v1.services(serviceSid).conversations.create({
            friendlyName: friendlyName
        })

        res.status(200).send({ conversationSid: conversation.sid });
    } catch (error: any) {
        console.error('Error creating conversation:', error);
        res.status(500).send({ error: error.message });
    }
});

// Endpoint to list all conversations
app.get('/list-conversations', async (req, res) => {
    try {
        const conversations = await client.conversations.v1.services(serviceSid).conversations.list();

        res.status(200).send(conversations);
    } catch (error: any) {
        console.error('Error listing conversations:', error);
        res.status(500).send({ error: error.message });
    }
});

// Endpoint to join a conversation by its friendly name and return conversation details with messages
app.post('/join-and-get-conversation', async (req, res) => {
    const { conversationSid, participantIdentity } = req.body;

    if (!conversationSid || !participantIdentity) {
        res.status(400).send({ error: 'Both conversationSid and participantIdentity are required' });
    }

    try {
        // Step 2: Find the conversation by friendly name
        const conversation = await client.conversations.v1
            .services(serviceSid).conversations(conversationSid).fetch();

        if (!conversation) {
            res.status(404).send({ error: `No conversation found with sid: ${conversationSid}` });
        }

        // Step 3: Check if the participant already exists in the conversation
        const participants = await client.conversations.v1
            .services(serviceSid)
            .conversations(conversation.sid)
            .participants.list();

        const participantExists = participants.some(
            (participant: ParticipantInstance) => participant.identity === participantIdentity
        );

        if (!participantExists) {
            // Step 4: Add the participant if they don't exist
            await client.conversations.v1
                .services(serviceSid)
                .conversations(conversation.sid)
                .participants.create({ identity: participantIdentity });
            console.log(`Participant ${participantIdentity} added to conversation`);
        } else {
            console.log(`Participant ${participantIdentity} already exists in the conversation`);
        }

        // Step 5: Fetch the messages from the conversation
        // const messages = await getMessages(conversation);

        // Step 6: Return the conversation details
        const updatedConversation = await client.conversations.v1
            .services(serviceSid)
            .conversations(conversation.sid)
            .fetch();

        res.status(200).send({
            message: `Participant ${participantIdentity} processed in conversation`,
            conversation: updatedConversation
        });
    } catch (error) {
        console.error('Error:', error);
        res.status(500).send({ error: 'Failed to process the conversation' });
    }
});

// Route to handle file upload
app.post('/upload-media', upload.single('file'), async (req, res) => {

    const file = req.file;
    const mediaUrl = `http://localhost:${port}/uploads/${file!.filename}`;

    res.status(200).send({
        mediaUrl: mediaUrl
    });

});

// Serve the uploaded media files (for testing purposes)
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

async function getMessages(conversationSid: string) {
    console.log(conversationSid);
    return await client.conversations.v1
        .services(serviceSid)
        .conversations(conversationSid)
        .messages
        .list();
}
app.post('/get-messages', async (req, res) => {
    const { conversationSid } = req.body;
    const messages = await getMessages(conversationSid);
    res.status(200).send({
        message: 'Message sent successfully',
        messages: messages
    });
})

// SMS
app.post('/send-sms', async (req, res) => {
    
    try {
        const { message, to } = req.body;

        const messageInstance = await client.messages.create({
            body: message,
            to: to,
            from: process.env.TWILIO_PHONE_NUMBER
        });

        console.log(messageInstance);

        res.status(200).send();
    } catch (e) {
        console.error(e);
        res.status(400).send();
        throw e;
    }

});

app.get('/get-inbox', async (req, res) => {
    
    const messages = await client.messages.list({
        to: process.env.TWILIO_PHONE_NUMBER,
        dateSentAfter: new Date(1737054649000)
    })

    res.status(200).send({
        info: `Inbox of number ${process.env.TWILIO_PHONE_NUMBER}`,
        messages: messages
    });
    
});

// Array to store SSE clients
const clients: Response[] = [];

app.get("/message-received-event", (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add the client response to the list
    clients.push(res);

    // Remove client on disconnect
    req.on('close', () => {
        const index = clients.indexOf(res);
        if (index !== -1) {
            clients.splice(index, 1);
        }
    });
});

app.get("/email-events", (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add the client response to the list
    clients.push(res);

    // Remove client on disconnect
    req.on('close', () => {
        const index = clients.indexOf(res);
        if (index !== -1) {
            clients.splice(index, 1);
        }
    });
});

// Twilio Webhook
app.post('/webhook', (req: Request, res: Response) => {

    console.log(`Received a message! Prompting all listening clients to refresh inbox...`);

    // Notify all connected SSE clients
    clients.forEach((client) => {
        client.write(`data: ${JSON.stringify({ message: "Hey! Update your inbox!" })}\n\n`);
    });

    console.log(`Updated ${clients.length} client(s).`);

    // Respond to Twilio
    res.status(200).send('<Response></Response>');
});


// EMAIL
import sgMail, { MailDataRequired } from '@sendgrid/mail';
import { VoiceGrant } from "twilio/lib/jwt/AccessToken";

sgMail.setApiKey(process.env.SENDGRID_API_KEY!);

// Route to send an email
app.post('/send-email', (req, res) => {
    const { to, cc, bcc, subject, message, attachment } = req.body;
    console.log({ to, cc, bcc, subject, message, attachment });
  
    const mailOptions: MailDataRequired = {
      from: process.env.SENDGRID_EMAIL!,
      to: to.split(",").map((rec: string) => rec.trim()),                       
      cc: cc.split(",").map((rec: string) => rec.trim()),
      bcc: bcc.split(",").map((rec: string) => rec.trim()),
      subject: subject,             
      text: message,                  
      html: `<p>${message}</p>`
    };

    if (attachment) {
        mailOptions.attachments = [
            attachment
        ]
    }
  
    // Send email
    sgMail.send(mailOptions)
        .then(() => {
            console.log('Email sent');
            res.status(200).send();
        })
        .catch((error) => {
            console.error(error);
            res.status(400).send();
        });
});

app.get('/emails', async (req, res) => {
    try {
        const auth = await authorize();
        const emails = await getEmailsAfterDate(auth, '2025-01-16T19:58:00Z'); // January 16, 2025, 00:00 GMT +8
        res.status(200).send(emails);
    } catch (error) {
        console.error('Error fetching emails:', error);
        res.status(500).send({ error: 'Failed to fetch emails' });
    }
});

// VOICE
// Array to store SSE clients
const callClients: Response[] = [];

// Endpoint to handle incoming call events
app.get("/incoming-call-event", (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // Add the client response to the list
    callClients.push(res);

    // Remove client on disconnect
    req.on('close', () => {
        const index = callClients.indexOf(res);
        if (index !== -1) {
            callClients.splice(index, 1);
        }
    });
});

app.post("/incoming-call", (req, res) => {
    console.log('Incoming call data:', req.body); // Log the incoming call data

    const twiml = new twilio.twiml.VoiceResponse();

    if (req.body.Caller !== 'client:User-1') {
        const dial = twiml.dial();
        console.log("Redirecting to the app...");
        dial.client('User-1');
    } else {
        const dial = twiml.dial({ callerId: process.env.TWILIO_PHONE_NUMBER });
        const toNumber = req.body.To;
        if (toNumber) {
            console.log(`Calling number ${toNumber}`);
            dial.number(toNumber); // Correctly add the number to the <Dial> element
        } else {
            console.error("No 'To' number provided in the request.");
            twiml.say("No 'To' number provided.");
        }
    }
    res.type('text/xml');
    res.send(twiml.toString());

});

app.post('/twiml', (req, res) => {
    const twiml = new twilio.twiml.VoiceResponse();
    const dial = twiml.dial();

    console.log(req.body);

    // Assuming the 'to' number is passed in the request body
    const fromNumber = req.body.From;
    if (fromNumber) {
        console.log(`Bridging call back to caller...`);
        dial.number(fromNumber); // Bridge the call to the 'to' number
    } else {
        console.error("No 'From' number provided in the request.");
        twiml.say("No 'From' number provided.");
    }

    res.type('text/xml');
    res.send(twiml.toString());
});

app.listen(port, () => {
    console.log(`Server running on port ${port}`);
});