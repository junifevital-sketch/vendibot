# Vendibot

Frontend em HTML/CSS/JS com painel de login, limite mensal por usuário e geração de anúncios via backend.

## Como iniciar

1. Abra o arquivo `backend/.env`.
2. Preencha:

```env
OPENAI_API_KEY=sua_chave_da_openai
SESSION_SECRET=um_segredo_longo_e_privado
PASSWORD_RESET_CODE=um_codigo_para_recuperar_senhas
```

3. Abra o terminal em `backend`.
4. Rode o servidor:

```powershell
npm.cmd start
```

5. Abra `http://localhost:3001/`.

## Observações

O backend também serve o frontend, então não é necessário rodar o `live-server` para uso normal. Se usar `npm.cmd start` dentro de `frontend`, a tela em `http://127.0.0.1:4173/` continuará chamando a API em `http://localhost:3001`.

Usuários são salvos em `backend/data/users.json`. Esse arquivo, uploads e `.env` ficam ignorados pelo Git.

Para trocar uma senha esquecida, use `Esqueci minha senha` na tela de login e informe o email da conta, a nova senha e o `PASSWORD_RESET_CODE` definido no `.env`.

## Produto online

Para publicar com dominio, Postgres, Stripe Checkout e variaveis de producao, veja `../DEPLOYMENT.md`.
