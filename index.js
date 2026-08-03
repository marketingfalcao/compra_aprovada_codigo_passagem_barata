require('dotenv').config();
const express = require('express');
const axios   = require('axios');

const app = express();
app.use(express.json());

const MANYCHAT_API = 'https://api.manychat.com';
const MC_TOKEN     = process.env.MANYCHAT_API_KEY;
const TAG_ID       = Number(process.env.MANYCHAT_TAG_ID);

// ── Helpers ───────────────────────────────────────────────────────────────────

async function findSubscriberByPhone(phone) {
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
}

async function createSubscriber(phone, firstName, lastName) {
  const response = await axios.post(
    `${MANYCHAT_API}/fb/subscriber/createSubscriber`,
    { phone, first_name: firstName, last_name: lastName },
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
    const phone     = payer.phone;
    const firstName = payer.firstName || 'Lead';
    const lastName  = payer.lastName  || '';

    if (!phone) {
      console.warn('⚠️  Telefone não encontrado no payload');
      return res.status(200).json({ ok: false, message: 'phone ausente' });
    }

    console.log(`📞 Telefone: ${phone} | Nome: ${firstName} ${lastName}`);

    // 4. Busca ou cria subscriber no ManyChat
    let subscriberId = await findSubscriberByPhone(phone);

    if (!subscriberId) {
      console.log('➕ Subscriber não encontrado, criando...');
      subscriberId = await createSubscriber(phone, firstName, lastName);
    }

    if (!subscriberId) {
      console.error('❌ Não foi possível obter subscriber_id');
      return res.status(500).json({ ok: false, message: 'subscriber_id nulo' });
    }

    // 5. Adiciona a tag
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