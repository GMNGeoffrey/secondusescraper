const fetch = require('node-fetch');
const nodemailer = require('nodemailer');
const cheerio = require('cheerio');

const functions = require('@google-cloud/functions-framework');

const firebaseAdmin = require('firebase-admin');
const firebaseApp = require('firebase-admin/app');

firebaseAdmin.initializeApp({ credentials: firebaseApp.applicationDefault() });
const db = firebaseAdmin.firestore();


const USER = process.env.GMAIL_SENDER;
const PASSWORD = process.env.GMAIL_APP_PASSWORD;
const RECIPIENTS = process.env.GMAIL_RECIPIENTS;
const SUBSCRIPTIONS_REGEX = new RegExp('users/(?<user>[^/]+)/subscriptions/(?<provider>[^/]+)');

const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
        user: USER,
        pass: PASSWORD,
    },
});

function arrayEquals(a, b) {
    return Array.isArray(a) &&
        Array.isArray(b) &&
        a.length === b.length &&
        a.every((val, index) => val === b[index]);
}

async function detectSecondUseChange($, providerRef) {
    const updatedMsg = $('.timestamp > p').text();
    const updated = await db.runTransaction(async (t) => {
        const doc = await t.get(providerRef);
        if (updatedMsg === doc.data().updatedMsg) {
            return false;
        }
        t.update(providerRef, { updatedMsg: updatedMsg });
        return true;
    });

    return updated;
}

async function detectBallardReuseChange($, providerRef) {
    const $products = $('ul.products').children('li.product')
    const links = $products.children('.product-images').map((_, e) => e.attribs.href).toArray();
    const firstLink = links[0];

    const updated = await db.runTransaction(async (t) => {
        const doc = await t.get(providerRef);
        const oldLinks = doc.data().productLinks;
        // If the first link has been seen before then there isn't new inventory.
        const updated = !oldLinks.includes(firstLink);
        // But stuff could've been removed (e.g. sold), so still update the list.
        if (!arrayEquals(links, oldLinks)) {
            t.update(providerRef, { productLinks: links });
        }
        return updated;
    });
    return updated;
}

async function sendSecondUseUpdateEmail($, user) {
    const updatedMsg = $('.timestamp > p').text();
    const subRef = db.doc(`users/${user}/subscriptions/second_use`);
    try {
        const _ = await db.runTransaction(async (t) => {
            const doc = await t.get(subRef);
            // Reference a message ID to keep things in one thread. Pick this up
            // from a past send event.
            const messageId = doc.data().messageId;
            const response = await transporter.sendMail({
                from: `"Salvage Watch" <${USER}>`,
                to: RECIPIENTS, // comma-separated recipients
                subject: "New inventory at Second Use",
                text: `Second Use ${updatedMsg} https://www.seconduse.com/inventory/`,
                html: `<b>Second Use ${updatedMsg} https://www.seconduse.com/inventory/</b>`,
                references: [messageId],
            });
            if (!messageId) {
                t.update(subRef, { messageId: response.messageId });
            }
        });
    } catch (e) {
        console.error(e);
    }
}

async function sendBallardReuseUseUpdateEmail($, user) {
    const subRef = db.doc(`users/${user}/subscriptions/ballard_reuse`);
    try {
        const _ = await db.runTransaction(async (t) => {
            const doc = await t.get(subRef);
            // Reference a message ID to keep things in one thread. Pick this up
            // from a past send event.
            const messageId = doc.data().messageId;
            const response = await transporter.sendMail({
                from: `"Salvage Watch" <${USER}>`,
                to: RECIPIENTS, // comma-separated recipients
                subject: "New inventory at Ballard Reuse",
                text: `Ballard Reuse https://www.ballardreuse.com/inventory/`,
                html: `<b>Ballard Reuse https://www.ballardreuse.com/inventory/</b>`,
                references: [messageId],
            });
            if (!messageId) {
                t.update(subRef, { messageId: response.messageId });
            }
        });
    } catch (e) {
        console.error(e);
    }
}


const PROVIDERS = {
    second_use: {
        url: "https://www.seconduse.com/inventory",
        hasChanged: detectSecondUseChange,
        sendUpdateEmail: sendSecondUseUpdateEmail,
    },
    ballard_reuse: {
        url: "https://www.ballardreuse.com/inventory",
        hasChanged: detectBallardReuseChange,
        sendUpdateEmail: sendBallardReuseUseUpdateEmail,
    },

};

async function scrape() {
    const subscriptions = await db.collectionGroup('subscriptions').get();
    const usersForProvider = {};
    subscriptions.forEach((sub) => {
        // User has not subscribed to base site updates.
        if (!sub.data().base) return;
        const match = sub.ref.path.match(SUBSCRIPTIONS_REGEX);
        if (match) {
            const user = match.groups.user;
            const provider = match.groups.provider;
            const providerEntry = usersForProvider[provider];
            if (providerEntry == undefined) {
                usersForProvider[provider] = [user];
            } else {
                providerEntry.push(user);
            }
        }
    });

    for (const providerName in PROVIDERS) {
        console.log(`Scraping ${providerName}`);
        const provider = PROVIDERS[providerName];
        const response = await fetch(provider.url);
        const body = await response.text();
        const $ = cheerio.load(body);
        const providerRef = db.collection('providers').doc(providerName);
        const updated = await provider.hasChanged($, providerRef);
        if (updated === true) {
            const users = usersForProvider[providerName] || [];
            console.log(`${providerName} has updated. Sending email to ${users.length} users`)
            for (const user of users) {
                try {
                    await provider.sendUpdateEmail($, user);
                    console.log(`Sent email for ${providerName}`);
                } catch (e) {
                    console.error(e);
                }
            }
        } else {
            console.log(`No updates for ${providerName}`);
        }
    }
}

// Register a CloudEvent function with the Functions Framework
functions.cloudEvent('scrape', cloudEvent => {
    scrape();
});

if (require.main === module) {
    scrape();
}
