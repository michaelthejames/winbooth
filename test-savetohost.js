// test-savetohost.js
const response = await fetch('https://localhost:3000/camera/0/SaveTo', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ value: 'Host' }),
});
console.log('Status:', response.status);
console.log('Body:', await response.json());