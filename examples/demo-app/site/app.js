// Demo shop app. A small single-page app with bugs planted on purpose.

const app = document.getElementById('app');
let products = [];
let user = null;
let savedCard = null;

// ---------- Cart (kept in localStorage) ----------

function getCart() {
  try {
    return JSON.parse(localStorage.getItem('cart') ?? '[]');
  } catch {
    return [];
  }
}

function saveCart(cart) {
  localStorage.setItem('cart', JSON.stringify(cart));
  updateCartCount();
}

function addToCart(id) {
  const cart = getCart();
  const line = cart.find((item) => item.id === id);
  if (line) line.qty += 1;
  else cart.push({ id, qty: 1 });
  saveCart(cart);
}

function updateCartCount() {
  const count = getCart().reduce((sum, item) => sum + item.qty, 0);
  document.getElementById('cart-count').textContent = String(count);
}

// Planted bug: with more than one item type, the first item is counted twice.
function cartTotal(lines) {
  let total = lines.reduce((sum, line) => sum + line.price * line.qty, 0);
  if (lines.length > 1) total += lines[0].price;
  return total;
}

function money(value) {
  return `$${value.toFixed(2)}`;
}

// ---------- Helpers ----------

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function go(path) {
  history.pushState({}, '', path);
  render();
}

async function loadUser() {
  const res = await fetch('/api/me');
  const data = res.ok ? await res.json() : {};
  user = data.name ? data : null;
  document.getElementById('user-name').textContent = user ? `Hi, ${user.name}` : '';
  document.getElementById('login-link').hidden = Boolean(user);
  document.getElementById('logout-button').hidden = !user;
}

// ---------- Pages ----------

function shopPage() {
  app.innerHTML = `
    <h1>Shop</h1>
    <div class="grid">
      ${products
        .map(
          (p) => `
        <article class="card">
          <img src="${p.image}" ${p.alt ? `alt="${escapeHtml(p.alt)}"` : ''} width="120" height="120" />
          <h2>${escapeHtml(p.name)}</h2>
          <p class="price">${money(p.price)}</p>
          <button type="button" data-add="${p.id}">Add to cart</button>
          <button type="button" class="secondary" data-stock="${p.id}">Check stock</button>
          <p class="stock-status" data-stock-status="${p.id}" role="status"></p>
        </article>`,
        )
        .join('')}
    </div>`;

  app.querySelectorAll('[data-add]').forEach((button) => {
    button.addEventListener('click', () => {
      addToCart(button.dataset.add);
      button.textContent = 'Added';
      setTimeout(() => {
        button.textContent = 'Add to cart';
      }, 1200);
    });
  });

  app.querySelectorAll('[data-stock]').forEach((button) => {
    button.addEventListener('click', async () => {
      const status = app.querySelector(`[data-stock-status="${button.dataset.stock}"]`);
      status.textContent = 'Checking...';
      const res = await fetch(`/api/stock?id=${button.dataset.stock}`);
      status.textContent = res.ok ? 'In stock' : 'Could not check stock. Try again later.';
      status.classList.toggle('error', !res.ok);
    });
  });
}

function cartPage() {
  const lines = getCart()
    .map((item) => {
      const product = products.find((p) => p.id === item.id);
      return product ? { ...product, qty: item.qty } : null;
    })
    .filter(Boolean);

  if (lines.length === 0) {
    app.innerHTML = `<h1>Cart</h1><p>Your cart is empty.</p><p><a href="/" data-link>Go shopping</a></p>`;
    return;
  }

  app.innerHTML = `
    <h1>Cart</h1>
    <table class="cart-table">
      <thead><tr><th>Item</th><th>Qty</th><th>Price</th><th></th></tr></thead>
      <tbody>
        ${lines
          .map(
            (line) => `
          <tr>
            <td>${escapeHtml(line.name)}</td>
            <td>${line.qty}</td>
            <td>${money(line.price * line.qty)}</td>
            <td><button type="button" class="link-button" data-remove="${line.id}">Remove</button></td>
          </tr>`,
          )
          .join('')}
      </tbody>
    </table>
    <p class="total">Total: <strong id="cart-total">${money(cartTotal(lines))}</strong></p>

    <div class="coupon">
      <input id="coupon-code" placeholder="Coupon code" />
      <button type="button" id="apply-coupon" class="secondary">Apply coupon</button>
      <p id="coupon-status" role="status"></p>
    </div>

    <button type="button" id="checkout-button">Checkout</button>`;

  app.querySelectorAll('[data-remove]').forEach((button) => {
    button.addEventListener('click', () => {
      saveCart(getCart().filter((item) => item.id !== button.dataset.remove));
      cartPage();
    });
  });

  // Planted bug: this throws an error in the console and nothing happens.
  document.getElementById('apply-coupon').addEventListener('click', () => {
    const coupon = window.activeCoupons.find((c) => c.code === 'SAVE10');
    document.getElementById('coupon-status').textContent = `Coupon ${coupon.code} applied.`;
  });

  document.getElementById('checkout-button').addEventListener('click', () => go('/checkout'));
}

function checkoutPage() {
  if (getCart().length === 0) {
    go('/cart');
    return;
  }
  app.innerHTML = `
    <h1>Checkout</h1>
    <form id="checkout-form" class="stack">
      <label>Full name <input name="name" autocomplete="name" required /></label>
      <label>Email <input name="email" type="email" autocomplete="email" required /></label>
      <label>Address <textarea name="address" rows="2" required></textarea></label>
      <label>Delivery
        <select name="delivery">
          <option value="standard">Standard (free)</option>
          <option value="express">Express ($5.00)</option>
        </select>
      </label>
      <label class="inline"><input type="checkbox" name="gift" /> This is a gift</label>
    </form>
    <iframe src="/payment-frame.html" title="Payment form" class="payment-frame"></iframe>
    <p id="card-status" role="status">${savedCard ? `Card ending in ${savedCard} is ready.` : 'Add a card above.'}</p>
    <button type="button" id="place-order" data-testid="place-order">Place order</button>
    <p id="checkout-error" class="error" role="alert"></p>`;

  document.getElementById('place-order').addEventListener('click', async () => {
    const form = document.getElementById('checkout-form');
    const error = document.getElementById('checkout-error');
    if (!form.reportValidity()) return;
    if (!savedCard) {
      error.textContent = 'Save a card before you place the order.';
      return;
    }
    if (!window.confirm('Place this order?')) {
      error.textContent = 'Order not placed.';
      return;
    }
    const res = await fetch('/api/order', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ items: getCart() }),
    });
    const { orderId } = await res.json();
    saveCart([]);
    savedCard = null;
    go(`/order/${orderId}`);
  });
}

function orderPage(orderId) {
  app.innerHTML = `
    <h1>Thank you</h1>
    <p>Your order <strong id="order-id">${escapeHtml(orderId)}</strong> is placed.</p>
    <p><a href="/" data-link>Keep shopping</a></p>`;
}

function loginPage() {
  app.innerHTML = `
    <h1>Log in</h1>
    <form id="login-form" class="stack narrow">
      <label>Username <input name="username" autocomplete="username" required /></label>
      <label>Password <input name="password" type="password" autocomplete="current-password" required /></label>
      <button type="submit">Log in</button>
      <p id="login-error" class="error" role="alert"></p>
    </form>`;

  document.getElementById('login-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: form.username.value, password: form.password.value }),
    });
    if (!res.ok) {
      document.getElementById('login-error').textContent = 'Wrong username or password.';
      return;
    }
    await loadUser();
    go('/account');
  });
}

function accountPage() {
  if (!user) {
    app.innerHTML = `<h1>Account</h1><p>Please <a href="/login" data-link>log in</a> to see your account.</p>`;
    return;
  }
  app.innerHTML = `
    <h1>Account</h1>
    <p>Logged in as <strong>${escapeHtml(user.name)}</strong>.</p>
    <h2>Profile picture</h2>
    <label>Upload a picture <input type="file" id="avatar-input" accept="image/*,.txt" /></label>
    <p id="avatar-status" role="status">No file chosen yet.</p>`;

  document.getElementById('avatar-input').addEventListener('change', (event) => {
    const file = event.target.files[0];
    document.getElementById('avatar-status').textContent = file
      ? `Uploaded ${file.name} (${file.size} bytes).`
      : 'No file chosen yet.';
  });
}

function notFoundPage() {
  app.innerHTML = `<h1>Page not found</h1><p><a href="/" data-link>Back to the shop</a></p>`;
}

// ---------- Router ----------

function render() {
  const path = location.pathname;
  if (path === '/') shopPage();
  else if (path === '/cart') cartPage();
  else if (path === '/checkout') checkoutPage();
  else if (path === '/login') loginPage();
  else if (path === '/account') accountPage();
  else if (path.startsWith('/order/')) orderPage(path.slice('/order/'.length));
  else notFoundPage();
  app.focus();
}

// Links with data-link change the page without a full reload.
document.addEventListener('click', (event) => {
  const link = event.target.closest('a[data-link]');
  if (!link) return;
  event.preventDefault();
  go(link.getAttribute('href'));
});

window.addEventListener('popstate', render);

window.addEventListener('message', (event) => {
  if (event.origin !== location.origin || event.data?.type !== 'card-saved') return;
  savedCard = event.data.last4;
  const status = document.getElementById('card-status');
  if (status) status.textContent = `Card ending in ${savedCard} is ready.`;
});

document.getElementById('logout-button').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST' });
  await loadUser();
  go('/');
});

async function start() {
  products = await (await fetch('/api/products')).json();
  await loadUser();
  updateCartCount();
  render();
}

start();
