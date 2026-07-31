require('dotenv').config();
const express = require('express');
const axios   = require('axios');

const app = express();
app.use(express.json());

const MANYCHAT_API  = 'https://api.manychat.com';
const MC_TOKEN      = process.env.MANYCHAT_API_KEY;  // ex: 3530366:0021b8...
const TAG_ID        = Number(process.env.MANYCHAT_TAG_ID); // 93197500

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Busca o subscriber_id pelo telefone (formato E.164: +5511999999999) */
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

/** Cria subscriber no ManyChat (caso ainda não exista) */
async function createSubscriber(phone, name) {
  const [first_name, ...rest] = (name || 'Lead').split(' ');
  const response = await axios.post(
    `${MANYCHAT_API}/fb/subscriber/createSubscriber`,
    {
      phone,
      first_name,
      last_name: rest.join(' ') || '',
    },
    { headers: { Authorization: `Bearer ${MC_TOKEN}` } }
  );
  return response.data?.data?.id || null;
}

/** Adiciona a tag ao subscriber */
async function addTagToSubscriber(subscriber_id) {
  await axios.post(
    `${MANYCHAT_API}/fb/subscriber/addTag`,
    { subscriber_id, tag_id: TAG_ID },
    { headers: { Authorization: `Bearer ${MC_TOKEN}` } }
  );
}

// ── Normaliza telefone para E.164 ─────────────────────────────────────────────
function normalizePhone(raw) {
  if (!raw) return null;
  // Remove tudo que não for dígito
  let digits = String(raw).replace(/\D/g, '');
  // Se vier sem DDI, adiciona o 55 (Brasil)
  if (digits.length === 10 || digits.length === 11) {
    digits = '55' + digits;
  }
  return '+' + digits; // ex: +5511987654321
}

// ── Webhook endpoint ──────────────────────────────────────────────────────────

app.post('/webhook/hubla', async (req, res) => {
  try {
    const body = req.body;
    console.log('📩 Webhook recebido da Hubla:', JSON.stringify(body, null, 2));

    // ── 1. Filtra apenas eventos de compra aprovada ──────────────────────────
    //  A Hubla envia eventos como: "order.approved", "purchase.approved" etc.
    //  Ajuste o campo e valor conforme o payload real da sua conta Hubla.
    const eventType = body?.event || body?.type || body?.data?.event;
    const APROVADO  = ['order.approved', 'purchase.approved', 'APPROVED'];

    if (!APROVADO.some(e => String(eventType).includes(e))) {
      console.log('⏩ Evento ignorado:', eventType);
      return res.status(200).json({ ok: true, message: 'evento ignorado' });
    }

    // ── 2. Extrai dados do comprador ─────────────────────────────────────────
    //  Ajuste os caminhos conforme o JSON real que a Hubla envia.
    const buyer  = body?.data?.buyer || body?.buyer || body?.customer || {};
    const rawPhone = buyer.phone || buyer.phone_number || buyer.telephone;
    const name     = buyer.name  || buyer.full_name || 'Lead';

    const phone = normalizePhone(rawPhone);
    if (!phone) {
      console.warn('⚠️  Telefone não encontrado no payload');
      return res.status(200).json({ ok: false, message: 'phone ausente' });
    }

    console.log(`📞 Telefone normalizado: ${phone} | Nome: ${name}`);

    // ── 3. Busca ou cria subscriber no ManyChat ──────────────────────────────
    let subscriberId = await findSubscriberByPhone(phone);

    if (!subscriberId) {
      console.log('➕ Subscriber não encontrado, criando...');
      subscriberId = await createSubscriber(phone, name);
    }

    if (!subscriberId) {
      console.error('❌ Não foi possível obter subscriber_id');
      return res.status(500).json({ ok: false, message: 'subscriber_id nulo' });
    }

    // ── 4. Adiciona a tag de compra aprovada ─────────────────────────────────
    await addTagToSubscriber(subscriberId);
    console.log(`✅ Tag ${TAG_ID} adicionada para subscriber ${subscriberId}`);

    return res.status(200).json({ ok: true, subscriber_id: subscriberId });

  } catch (err) {
    console.error('❌ Erro na integração:', err?.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/', (_req, res) => res.json({ status: 'ok', service: 'hubla-manychat' }));

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Servidor rodando na porta ${process.env.PORT || 3000}`);
});