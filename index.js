const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const cheerio = require('cheerio');

const functions = require('@google-cloud/functions-framework');

const firebaseAdmin = require('firebase-admin');
const firebaseApp = require('firebase-admin/app')

firebaseAdmin.initializeApp({credentials: firebaseApp.applicationDefault()});
const db = firebaseAdmin.firestore();
const timestampRef = db.collection('seconduse').doc('timestamp')


const USER = process.env.GMAIL_SENDER
const PASSWORD = process.env.GMAIL_APP_PASSWORD
const RECIPIENTS = process.env.GMAIL_RECIPIENTS
// Reference a message ID to keep things in one thread. Pick this up from a past
// send event.
const MESSAGE_ID_REF = process.env.MESSAGE_ID_REF

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: USER,
        pass: PASSWORD,
    },
});

const buildEmailObject = (newTimestamp) => {
    return {
        from: `"Second Use Mailer" <${USER}>`,
        to: RECIPIENTS, // comma-separated recipients
        subject: "There is new inventory at Second Use",
        text: `Second Use ${newTimestamp} https://www.seconduse.com/inventory/`,
        html: `<b>Second Use ${newTimestamp} https://www.seconduse.com/inventory/</b>`,
        references: [MESSAGE_ID_REF],
    };
};

async function sendUpdateEmail(newTimestamp) {
    transporter.sendMail(buildEmailObject(newTimestamp)).then(info => {
        console.log({ info });
    }).catch(console.error);
}

async function updateTimestamp(newTimestamp) {
    const updated = await db.runTransaction(async (t) => {
        const doc = await t.get(timestampRef);
        if (newTimestamp === doc.data().updatedMsg) {
            return false;
        }
        t.update(timestampRef, {updatedMsg: newTimestamp});
        return true
    });

    return updated;
}

async function scrape() {
    const response = await fetch('https://www.seconduse.com/inventory/');
    const body = await response.text();
    const $ = cheerio.load(body);
    const newTimestamp = $('.timestamp > p').text();
    const updated = await updateTimestamp(newTimestamp);
    if (updated === true) {
        sendUpdateEmail(newTimestamp);
        console.log("Sent email.");
    } else {
        console.log("No new updates.")
    }
}

// Register a CloudEvent function with the Functions Framework
functions.cloudEvent('scrapeSecondUse', cloudEvent => {
    scrape();
});

if (require.main === module) {
    scrape();
}
