import { firebaseConfig, firebaseSdkUrl, applyFirebaseProxies } from "./config.js";

const [{ initializeApp }, authMod] = await Promise.all([
  import(firebaseSdkUrl("firebase-app.js")),
  import(firebaseSdkUrl("firebase-auth.js"))
]);

const { getAuth, applyActionCode, verifyPasswordResetCode, confirmPasswordReset } = authMod;

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
applyFirebaseProxies(auth);

function showStep(name){
  document.querySelectorAll("[data-step]").forEach(el => {
    el.classList.toggle("active", el.dataset.step === name);
  });
}

function showError(message){
  if (message) document.getElementById("errorText").textContent = message;
  showStep("error");
}

const ACTION_ERROR_MESSAGES = {
  "auth/expired-action-code": "Срок действия ссылки истёк — запросите новую.",
  "auth/invalid-action-code": "Ссылка уже использована или недействительна — запросите новую.",
  "auth/user-disabled": "Этот аккаунт отключён.",
  "auth/user-not-found": "Аккаунт не найден — возможно, он уже был удалён.",
  "auth/weak-password": "Пароль слишком короткий (минимум 6 символов)."
};

const params = new URLSearchParams(location.search);
const mode = params.get("mode");
const oobCode = params.get("oobCode");

if (!oobCode) {
  showError("В ссылке не хватает кода подтверждения — откройте её из письма ещё раз, не изменяя адрес.");
} else if (mode === "verifyEmail") {
  applyActionCode(auth, oobCode)
    .then(() => {
      showStep("verify-success");
      // Автопереход через 3 секунды — но кнопка "Перейти в каталог" никуда не делась
      // на случай, если человек ещё читает страницу и не хочет ждать автоматизма.
      let left = 3;
      const el = document.getElementById("verifyCountdown");
      const tick = () => {
        el.textContent = left > 0 ? `Переходим в каталог через ${left}…` : "";
        if (left <= 0) { location.href = "/"; return; }
        left -= 1;
        setTimeout(tick, 1000);
      };
      tick();
    })
    .catch(err => showError(ACTION_ERROR_MESSAGES[err.code] || err.message));
} else if (mode === "resetPassword") {
  verifyPasswordResetCode(auth, oobCode)
    .then(email => {
      document.getElementById("resetForEmail").textContent = `Для аккаунта ${email}`;
      showStep("reset-form");

      const pass1 = document.getElementById("newPassword");
      const pass2 = document.getElementById("newPasswordRepeat");
      const errEl = document.getElementById("resetFormError");
      const btn = document.getElementById("resetConfirmBtn");

      btn.addEventListener("click", async () => {
        errEl.style.display = "none";
        const p1 = pass1.value, p2 = pass2.value;

        if (p1.length < 6) {
          errEl.textContent = "Пароль слишком короткий (минимум 6 символов).";
          errEl.style.display = "block";
          return;
        }
        if (p1 !== p2) {
          errEl.textContent = "Пароли не совпадают.";
          errEl.style.display = "block";
          return;
        }

        const originalLabel = btn.textContent;
        try {
          btn.disabled = true;
          btn.innerHTML = `<span class="btn-spinner"></span>Сохраняем…`;
          await confirmPasswordReset(auth, oobCode, p1);
          showStep("reset-success");
        } catch (err) {
          errEl.textContent = ACTION_ERROR_MESSAGES[err.code] || err.message;
          errEl.style.display = "block";
          btn.disabled = false;
          btn.textContent = originalLabel;
        }
      });
    })
    .catch(err => showError(ACTION_ERROR_MESSAGES[err.code] || err.message));
} else {
  showError("Неизвестный тип ссылки. Откройте письмо ещё раз или запросите новую.");
}
