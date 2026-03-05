import Groq from 'groq-sdk';
import dotenv from 'dotenv';
dotenv.config();

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

async function testGroq() {
    try {
        console.log("Sending tiny generic request to Groq...");
        const response = await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: 'test' }],
            max_tokens: 10,
        });
        console.log("Success! Response:", response.choices[0].message.content);

        console.log("\nSending large request to test TPM limit...");
        const largeText = "test ".repeat(1000);
        await groq.chat.completions.create({
            model: 'llama-3.3-70b-versatile',
            messages: [{ role: 'user', content: largeText }],
            max_tokens: 10,
        });
        console.log("Large request succeeded too.");
    } catch (err: any) {
        console.error("\nGroq Error Payload:", err.response?.data || err.error?.error || err.message || err);
    }
}

testGroq();
