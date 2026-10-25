// Seeds the demo app's worklist (invented data). scenecast runs it before recording, with
// SCENECAST_BASE_URL set to the scene file's app.baseUrl.
const base = process.env.SCENECAST_BASE_URL ?? 'http://127.0.0.1:4310';
const worklist = [
  { title: 'Approve the March travel request', due: 'Due today' },
  { title: 'Sign the updated work agreement', due: 'Due Friday' },
  { title: 'Review two new requests', due: 'This week' },
];
const res = await fetch(new URL('/api/seed', base), {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ worklist }),
});
if (!res.ok) {
  console.error(`seed failed: ${res.status} ${await res.text()}`);
  process.exit(1);
}
console.log(`seeded ${worklist.length} worklist items at ${base}`);
