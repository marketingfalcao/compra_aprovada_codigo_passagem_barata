require('dotenv').config();
const express = require('express');
const axios   = require('axios');

const app = express();
app.use(express.json());

const MANYCHAT_API_URL = 'https://api.manychat.com';
const TAG_NAME         = process.env.MANYCHAT_TAG_NAME || 'compra_aprovada_codigo_passagem_barata';

// ── Utils ─────────────────────────────────────────────────────────────────────

function getHeaders(apiKey = process.env.MANYCHAT_API_KEY) {
  if (!apiKey) throw new Error('API Key do ManyChat não informada.');
  return {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
}

function onlyDigits(value = '') {
  return String(value || '').replace(/\D/g, '');
}

function normalizePhoneVariants(phone = '') {
  const digits = onlyDigits(phone);
  if (!digits) return [];

  const variants = new Set();
  if (digits.startsWith('55')) {
    variants.add(digits);
    variants.add(`+${digits}`);
    variants.add(digits.slice(2));
    variants.add(`+${digits.slice(2)}`);
  } else {
    variants.add(digits);
    variants.add(`+${digits}`);
    variants.add(`55${digits}`);
    variants.add(`+55${digits}`);
  }
  return Array.from(variants).filter(Boolean);
}

function splitName(fullName = '') {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || '',
    lastName:  parts.slice(1).join(' '),
  };
}

function extractSubscriber(payload) {
  if (!payload) return null;
  if (payload?.id) return payload;
  if (payload?.data?.id) return payload.data;
  if (Array.isArray(payload?.data) && payload.data[0]?.id) return payload.data[0];
  if (Array.isArray(payload) && payload[0]?.id) return payload[0];
  return null;
}

function phoneMatches(possiblePhone, targetPhone) {
  const p      = onlyDigits(possiblePhone);
  const target = onlyDigits(targetPhone);
  if (!p || !target) return false;
  return (
    p === target ||
    p === `55${target}` ||
    target === `55${p}` ||
    p.endsWith(target) ||
    target.endsWith(p)
  );
}

function extractExistingWhatsappId(apiError) {
  const text  = JSON.stringify(apiError || '');
  const match = text.match(/This WhatsApp ID already exists:\s*(\d+)/i);
  return match?.[1] || null;
}

// ── ManyChat API ──────────────────────────────────────────────────────────────

async function findSubscriberBySystemField(params, apiKey) {
  try {
    const response = await axios.get(
      `${MANYCHAT_API_URL}/fb/subscriber/findBySystemField`,
      { headers: getHeaders(apiKey), params }
    );
    return extractSubscriber(response?.data);
  } catch (error) {
    console.log('❌ findBySystemField erro:', JSON.stringify({
      params,
      error: error?.response?.data || { message: error.message },
    }, null, 2));
    return null;
  }
}

async function findSubscriberByEmail(email, apiKey) {
  if (!email) return null;
  return findSubscriberBySystemField({ email }, apiKey);
}

async function findSubscriberByPhone(phone, apiKey) {
  const variants = normalizePhoneVariants(phone);
  for (const variant of variants) {
    const subscriber = await findSubscriberBySystemField({ phone: variant }, apiKey);
    if (subscriber?.id) {
      console.log(`✅ Subscriber encontrado por phone: ${subscriber.id}`);
      return subscriber;
    }
  }
  return null;
}

async function getSubscriberInfo(subscriberId, apiKey) {
  if (!subscriberId) return null;
  try {
    const response = await axios.get(
      `${MANYCHAT_API_URL}/fb/subscriber/getInfo`,
      { headers: getHeaders(apiKey), params: { subscriber_id: subscriberId } }
    );
    return response?.data?.data || response?.data || null;
  } catch (error) {
    console.log('❌ getInfo erro:', JSON.stringify(error?.response?.data || { message: error.message }, null, 2));
    return null;
  }
}

async function findSubscriberByNameAndPhone(name, phone, apiKey) {
  if (!phone) return null;
  const digits    = onlyDigits(phone);
  const nameParts = String(name || '').trim().split(/\s+/).filter(Boolean);

  const searchTerms = Array.from(new Set([
    name,
    nameParts[0],
    nameParts.slice(0, 2).join(' '),
    digits,
    digits.startsWith('55') ? digits.slice(2) : `55${digits}`,
  ].filter(Boolean)));

  for (const searchName of searchTerms) {
    try {
      console.log(`🔎 Buscando subscriber por nome: ${searchName}`);
      const response = await axios.get(
        `${MANYCHAT_API_URL}/fb/subscriber/findByName`,
        { headers: getHeaders(apiKey), params: { name: searchName } }
      );
      const results = Array.isArray(response?.data?.data) ? response.data.data : [];
      console.log(`🔎 findByName "${searchName}" encontrou ${results.length} resultado(s).`);

      for (const item of results) {
        const subscriberId = item?.id;
        if (!subscriberId) continue;
        const info = await getSubscriberInfo(subscriberId, apiKey);
        const possiblePhones = [
          item?.phone, item?.whatsapp_phone,
          info?.phone, info?.whatsapp_phone,
        ].filter(Boolean);
        const matched = possiblePhones.some(p => phoneMatches(p, phone));
        if (matched) {
          console.log(`✅ Subscriber encontrado por nome + telefone: ${subscriberId}`);
          return { id: subscriberId };
        }
      }
    } catch (error) {
      console.log(`❌ findByName erro (${searchName}):`, JSON.stringify(error?.response?.data || { message: error.message }, null, 2));
    }
  }
  return null;
}

async function createSubscriber({ phone, name, email, apiKey }) {
  const digits = onlyDigits(phone);
  if (!digits) throw new Error('Telefone inválido para criar subscriber.');

  const whatsappPhone    = digits.startsWith('55') ? digits : `55${digits}`;
  const { firstName, lastName } = splitName(name);

  const payload = {
    first_name:     firstName,
    last_name:      lastName,
    whatsapp_phone: whatsappPhone,
    has_opt_in_sms: true,
    consent_phrase: 'Aceito receber mensagens.',
  };

  if (email) {
    payload.email            = email;
    payload.has_opt_in_email = true;
  }

  try {
    const response   = await axios.post(
      `${MANYCHAT_API_URL}/fb/subscriber/createSubscriber`,
      payload,
      { headers: getHeaders(apiKey) }
    );
    const subscriber = extractSubscriber(response?.data);
    if (subscriber?.id) return subscriber;
    throw new Error('ManyChat criou subscriber sem retornar id.');
  } catch (error) {
    const apiError = error?.response?.data || { message: error.message };
    console.log('❌ createSubscriber erro:', JSON.stringify(apiError, null, 2));

    // Tenta recuperar se WhatsApp já existe
    const existingWaId = extractExistingWhatsappId(apiError);
    if (existingWaId) {
      console.log(`🔎 WhatsApp já existe: ${existingWaId}`);
      const s = await findSubscriberByPhone(existingWaId, apiKey)
             || await findSubscriberByNameAndPhone(name, existingWaId, apiKey);
      if (s?.id) return s;
    }

    // Fallbacks de busca
    const byPhone = await findSubscriberByPhone(phone, apiKey);
    if (byPhone?.id) return byPhone;

    const byNamePhone = await findSubscriberByNameAndPhone(name, phone, apiKey);
    if (byNamePhone?.id) return byNamePhone;

    const byEmail = await findSubscriberByEmail(email, apiKey);
    if (byEmail?.id) return byEmail;

    // Tenta sem email se der erro de permissão
    const errorText = JSON.stringify(apiError).toLowerCase();
    if (email && errorText.includes('permission denied to import email')) {
      console.log('⚠️  Tentando criar subscriber sem email...');
      return createSubscriber({ phone, name, email: null, apiKey });
    }

    throw new Error(`Erro no createSubscriber: ${JSON.stringify(apiError)}`);
  }
}

async function updateSubscriber(subscriberId, { name, email, phone, apiKey }) {
  if (!subscriberId) return null;
  const { firstName, lastName } = splitName(name);
  const digits = onlyDigits(phone);

  const payload = {
    subscriber_id: Number(subscriberId),
    first_name:    firstName || undefined,
    last_name:     lastName  || undefined,
    phone:         digits    || undefined,
    has_opt_in_sms: Boolean(digits),
    consent_phrase: 'Aceito receber mensagens.',
  };

  if (email) {
    payload.email            = email;
    payload.has_opt_in_email = true;
  }

  try {
    const response = await axios.post(
      `${MANYCHAT_API_URL}/fb/subscriber/updateSubscriber`,
      payload,
      { headers: getHeaders(apiKey) }
    );
    return response?.data || null;
  } catch (error) {
    console.log('❌ updateSubscriber erro:', JSON.stringify(error?.response?.data || { message: error.message }, null, 2));
    return null;
  }
}

async function addTagByName(subscriberId, tagName, apiKey) {
  const response = await axios.post(
    `${MANYCHAT_API_URL}/fb/subscriber/addTagByName`,
    { subscriber_id: Number(subscriberId), tag_name: tagName },
    { headers: getHeaders(apiKey) }
  );
  return response?.data || null;
}

async function setCustomFields(subscriberId, fields, apiKey) {
  try {
    // fields = [{ field_name: 'email', field_value: '...' }, ...]
    for (const field of fields) {
      if (!field.field_value) continue;
      await axios.post(
        `${MANYCHAT_API_URL}/fb/subscriber/setCustomFieldByName`,
        {
          subscriber_id: Number(subscriberId),
          field_name:    field.field_name,
          field_value:   field.field_value,
        },
        { headers: getHeaders(apiKey) }
      );
      console.log(`📝 Campo "${field.field_name}" definido: ${field.field_value}`);
    }
  } catch (error) {
    console.warn('⚠️  setCustomFields erro:', JSON.stringify(error?.response?.data || { message: error.message }, null, 2));
  }
}

async function ensureSubscriberAndAddTag({ name, email, phone, tagName, apiKey }) {
  let subscriber = null;

  if (phone) {
    subscriber = await findSubscriberByPhone(phone, apiKey);
  }
  if (!subscriber && email) {
    subscriber = await findSubscriberByEmail(email, apiKey);
  }
  if (!subscriber) {
    subscriber = await createSubscriber({ phone, name, email, apiKey });
  } else {
    await updateSubscriber(subscriber.id, { name, email, phone, apiKey });
  }

  if (!subscriber?.id) {
    throw new Error(`Não foi possível localizar ou criar subscriber. phone=${phone} email=${email}`);
  }

  await addTagByName(subscriber.id, tagName, apiKey);

  // Preenche campos personalizados
  await setCustomFields(subscriber.id, [
    { field_name: 'email',        field_value: email },
    { field_name: 'phone_number', field_value: phone },
  ], apiKey);

  return {
    subscriberId: subscriber.id,
    name, email, phone, tagName,
  };
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
    const payer = body.event.invoice.payer || body.event.user || {};
    const name  = `${payer.firstName || ''} ${payer.lastName || ''}`.trim() || 'Lead';
    const email = payer.email || null;
    const phone = payer.phone || null;

    console.log(`👤 Nome: ${name} | 📧 Email: ${email} | 📞 Telefone: ${phone}`);

    if (!phone && !email) {
      console.warn('⚠️  Email e telefone ausentes');
      return res.status(200).json({ ok: false, message: 'email e phone ausentes' });
    }

    // 4. Garante subscriber e adiciona tag
    const result = await ensureSubscriberAndAddTag({
      name,
      email,
      phone,
      tagName: TAG_NAME,
      apiKey:  process.env.MANYCHAT_API_KEY,
    });

    console.log(`✅ Tag "${TAG_NAME}" adicionada para subscriber ${result.subscriberId}`);
    return res.status(200).json({ ok: true, ...result });

  } catch (err) {
    console.error('❌ Erro geral:', err?.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

// ── Webhook Typeform ──────────────────────────────────────────────────────────

const TYPEFORM_TAG_NAME = process.env.TYPEFORM_TAG_NAME || 'preencheu-type-codigo-passagem-barata';

app.post('/webhook/typeform', async (req, res) => {
  try {
    const body = req.body;
    console.log('📩 Typeform recebido:', JSON.stringify(body, null, 2));

    // 1. Extrai respostas do Typeform
    const answers  = body?.form_response?.answers || [];
    const hidden   = body?.form_response?.hidden  || {};
    const fields   = body?.form_response?.definition?.fields || [];

    // 2. Mapeia campo → resposta
    let email = hidden?.email || null;
    let phone = hidden?.phone || null;
    let name  = hidden?.name  || null;

    for (const answer of answers) {
      const fieldId = answer.field?.id;
      const field   = fields.find(f => f.id === fieldId);
      const type    = answer.type;
      const value   = answer[type] || null;

      if (!field || !value) continue;

      const label = String(field.title || '').toLowerCase();

      if (!email && (label.includes('email') || label.includes('e-mail'))) {
        email = value;
      }
      if (!phone && (label.includes('telefone') || label.includes('phone') || label.includes('whatsapp') || label.includes('número') || label.includes('numero'))) {
        phone = String(value);
      }
      if (!name && (label.includes('nome') || label.includes('name'))) {
        name = String(value);
      }
    }

    console.log(`📧 Email: ${email} | 📞 Telefone: ${phone} | 👤 Nome: ${name}`);

    if (!email && !phone) {
      console.warn('⚠️  Email e telefone ausentes no payload do Typeform');
      return res.status(200).json({ ok: false, message: 'email e phone ausentes' });
    }

    // 3. Busca subscriber no ManyChat
    let subscriber = null;

    if (phone) {
      subscriber = await findSubscriberByPhone(phone, process.env.MANYCHAT_API_KEY);
    }
    if (!subscriber && email) {
      subscriber = await findSubscriberByEmail(email, process.env.MANYCHAT_API_KEY);
    }
    if (!subscriber && name && phone) {
      subscriber = await findSubscriberByNameAndPhone(name, phone, process.env.MANYCHAT_API_KEY);
    }

    if (!subscriber?.id) {
      console.warn('⚠️  Subscriber não encontrado no ManyChat');
      return res.status(200).json({ ok: false, message: 'subscriber não encontrado no ManyChat', email, phone });
    }

    // 4. Adiciona a tag
    await addTagByName(subscriber.id, TYPEFORM_TAG_NAME, process.env.MANYCHAT_API_KEY);
    console.log(`✅ Tag "${TYPEFORM_TAG_NAME}" adicionada para subscriber ${subscriber.id}`);

    return res.status(200).json({ ok: true, subscriberId: subscriber.id, tagName: TYPEFORM_TAG_NAME });

  } catch (err) {
    console.error('❌ Erro Typeform:', err?.response?.data || err.message);
    return res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/', (_req, res) => res.json({ status: 'ok' }));

app.listen(process.env.PORT || 3000, () => {
  console.log(`🚀 Servidor rodando na porta ${process.env.PORT || 3000}`);
});