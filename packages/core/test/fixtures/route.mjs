// A route module for context.test.ts: answers every request it is given with a fixed JSON body.
export default async function (route) {
  await route.fulfill({ json: { via: 'module' } });
}
