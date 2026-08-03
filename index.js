require('dotenv').config();
const express = require('express');
const axios   = require('axios');

const app = express();
app.use(express.json());

const MANYCHAT_API = 'https://api.manychat.com';
const MC_TOKEN     = process.env.MANYCHAT_API_KEY;
const TAG_ID       = Number(process.env.MANYCHAT_TAG_ID);

// ── Normaliza telefone para E.164 ─────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) {
    digits = '55' + digits;
  }
  return '+' + digits; // ex: +5531986294903
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findSubscriberByEmail(email) {
  try {
    const response = await axios.get(
      `${MANYCHAT_API}/fb/subscriber/findBySystemField`,
      {
        params: { field_name: 'email', field_value: email },
        headers: { Authorization: `Bearer ${MC_TOKEN}` },
      }
    );
    const data = response.data;
    if (data.status === 'success' && data.data && data.data.id) {
      return data.data.id;
    }
    return null;
  } catch (err) {
    console.warn('⚠️  findByEmail falhou:', err?.response?.data || err.message);
    return null;
  }
}

async function findSubscriberByPhone(phone) {
  try {
    const response = await axios.get(
      `${MANYCHAT_API}/fb/subscriber/findBySystemField`,
      {
        params: { field_name: 'phone', field_value: phone },
        headers: { Authorization: `Bearer ${MC_TOKEN}` },
      }
    );
    const data = response.data;
    if (data.status === 'success' && data.data && data.data.id) {
      return data.data.id;
    }
    return null;
  } catch (err) {
    console.warn('⚠️  findByPhone falhou:', err?.response?.data || err.message);
    return null;
  }
}

async function createSubscriber(email, phone, firstName, lastName) {
  const response = await axios.post(
    `${MANYCHAT_API}/fb/subscriber/createSubscriber`,
    {
      email,
      phone,
      first_name: firstName,
      last_name:  lastName,
    },
    { headers: { Authorization: `Bearer ${MC_TOKEN}` } }
  );
  return response.data?.data?.id || null;
}

async function addTagToSubscriber(subscriber_id) {
  await axios.post(
    `${MANYCHAT_API}/fb/subscriber/addTag`,
    { subscriber_id, tag_id: TAG_ID },
    { headers: { Authorization: `Bearer ${MC_TOKEN}` } }
  );
}

// ── Webhook ───────────────────────────────────────────────────────────────────

app.post('/webhook/hubla', async (req, res) => {
  try {
    const body = req.body;
    console.log('📩 Webhook recebido:', JSON.stringify(body, null, 2));

    // 1. Valida evento
    if (body.type !== 'invoice.payment_succeeded') {
      console.log('⏩ Evento ignorado:', body.type);
      return res.status(200).json({ ok: true, message: 'evento ignorado' });
    }

    // 2. Valida status paid
    if (body.event?.invoice?.status !== 'paid') {
      console.log('⏩ Status não é paid:', body.event?.invoice?.status);
      return res.status(200).json({ ok: true, message: 'status ignorado' });
    }

    // 3. Extrai dados do comprador
    const payer     = body.event.invoice.payer || body.event.user || {};
    const email     = payer.email;
    const phone     = normalizePhone(payer.phone);
    const firstName = payer.firstName || 'Lead';
    const lastName  = payer.lastName  || '';

    console.log(`📧 Email: ${email} | 📞 Telefone: ${phone} | Nome: ${firstName} ${lastName}`);

    if (!email && !phone) {
      console.warn('⚠️  Email e telefone ausentes no payload');
      return res.status(200).json({ ok: false, message: 'email e phone ausentes' });
    }

    // 4. Busca subscriber — primeiro por email, depois por telefone
    let subscriberId = null;

    if (email) {
      console.log('🔍 Buscando subscriber por email...');
      subscriberId = await findSubscriberByEmail(email);
    }

    if (!subscriberId && phone) {
      console.log('🔍 Buscando subscriber por telefone...');
      subscriberId = await findSubscriberByPhone(phone);
    }

    // 5. Se não encontrou, cria
    if (!subscriberId) {
      console.log('➕ Subscriber não encontrado, criando...');
      subscriberId = await createSubscriber(email, phone, firstName, lastName);
    }

    if (!subscriberId) {
      console.error('❌ Não foi possível obter subscriber_id');
      return res.status(500).json({ ok: false, message: 'subscriber_id nulo' });
    }

    console.log(`👤 Subscriber ID: ${subscriberId}`);

    // 6. Adiciona a tag de compra aprovada
    await addTagToSubscriber(subscriberId);
    console.log(`✅ Tag ${TAG_ID} adicionada para subscriber ${subscriberId}`);

    return res.status(200).json({ ok: true, subscriber_id: subscriberId });

  } catch (err) {
    console.error('❌ Erro:', err?.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (_req, res) => res.json({ status: 'ok' }));

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Servidor rodando na porta ${process.env.PORT || 3000}`);
});