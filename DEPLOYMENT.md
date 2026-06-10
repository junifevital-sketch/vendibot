# Vendibot online

Este projeto agora esta preparado para rodar como produto online com:

- Backend Node/Express servindo tambem o frontend estatico.
- Postgres via `DATABASE_URL` em producao.
- Stripe Checkout para upgrade Pro.
- Webhook Stripe para ativar/downgrade do plano.
- Headers de seguranca, CORS por origem e rate limit.
- Fallback JSON local para desenvolvimento.

## Arquitetura recomendada

Use um unico web service Node para comecar:

- Web service: Render, Railway, Fly.io ou similar.
- Banco: Postgres gerenciado do mesmo provedor ou Supabase.
- Pagamentos: Stripe Checkout com assinatura mensal.
- Dominio: comprado em Cloudflare, Namecheap, GoDaddy ou no proprio provedor.

Render e uma boa primeira escolha porque aceita Express com `npm install` + `npm start`,
tem Postgres gerenciado e facilita apontar dominio customizado.

## Variaveis de ambiente

Configure no provedor de hospedagem:

```env
NODE_ENV=production
PORT=3001
APP_URL=https://seu-dominio.com
ALLOWED_ORIGINS=https://seu-dominio.com
DATABASE_URL=postgresql://usuario:senha@host:5432/vendibot
DATABASE_SSL=true
OPENAI_API_KEY=sua_chave_openai
OPENAI_MODEL=gpt-4.1-mini
SESSION_SECRET=gere_um_valor_longo_aleatorio
PASSWORD_RESET_CODE=gere_um_codigo_privado
RESEND_API_KEY=re_...
EMAIL_FROM=Vendibot <noreply@seudominio.com>
SUPPORT_EMAIL=seu-email@dominio.com
PASSWORD_RESET_CODE_MINUTES=15
FREE_MONTHLY_LIMIT=5
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PRICE_ID=price_...
STRIPE_WEBHOOK_SECRET=whsec_...
ADMIN_EMAIL=seu-email@dominio.com
```

Para migrar usuarios locais de `backend/data/users.json` para o Postgres uma unica vez:

```env
MIGRATE_JSON_USERS=true
```

Depois do primeiro deploy bem-sucedido, volte para:

```env
MIGRATE_JSON_USERS=false
```

## Banco de dados

O backend cria automaticamente a tabela `users` no primeiro boot quando
`DATABASE_URL` esta definido. Em desenvolvimento, sem `DATABASE_URL`, ele continua
usando `backend/data/users.json`.

## Stripe

1. Crie um produto no Stripe.
2. Crie um preco recorrente mensal.
3. Copie o Price ID para `STRIPE_PRICE_ID`.
4. Configure um webhook para:

```text
https://seu-dominio.com/billing/webhook
```

5. Copie o signing secret para `STRIPE_WEBHOOK_SECRET`.
6. Assine estes eventos:

```text
checkout.session.completed
customer.subscription.deleted
customer.subscription.paused
```

O botao `Upgrade Pro` chama `/billing/create-checkout-session` e redireciona o
usuario para o checkout hospedado pelo Stripe. Quando o webhook confirma o
pagamento, o plano do usuario vira `pro`.

## Deploy

Comando de build:

```powershell
npm install
```

Comando de start:

```powershell
npm start
```

Diretorio do servico:

```text
backend
```

O backend serve o frontend a partir de `../frontend`, entao nao e necessario
publicar o frontend separadamente nesta primeira versao.

## Dominio

No provedor de hospedagem, adicione o dominio customizado e siga as instrucoes
de DNS. Normalmente voce vai criar:

- `CNAME www` apontando para o host do provedor.
- `A` ou `ALIAS/ANAME` para o dominio raiz, dependendo do provedor.

Quando o SSL estiver ativo, defina `APP_URL` e `ALLOWED_ORIGINS` com a URL final
em HTTPS.

## Checklist antes de vender

- `NODE_ENV=production`.
- `SESSION_SECRET` forte e privado.
- `DATABASE_URL` funcionando.
- `OPENAI_API_KEY` em producao.
- `STRIPE_SECRET_KEY`, `STRIPE_PRICE_ID` e `STRIPE_WEBHOOK_SECRET` preenchidos.
- Webhook Stripe testado.
- Dominio em HTTPS.
- `ALLOWED_ORIGINS` limitado ao dominio real.
- `backend/data/users.json` nao versionado.
- `backend/uploads` nao versionado.
- Teste de cadastro, login, gerar anuncio, limite gratis e upgrade Pro.

## Referencias oficiais

- Stripe Checkout: https://docs.stripe.com/payments/checkout
- Stripe Checkout Sessions API: https://docs.stripe.com/api/checkout/sessions
- Render Express deploy: https://render.com/docs/deploy-node-express-app
- Render environment variables: https://render.com/docs/configure-environment-variables
