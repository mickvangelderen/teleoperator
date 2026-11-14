# Viewer

A browser application for inspecting live headset and controller poses, body joints, inputs, and performance statistics from the [Operator](../operator/README.md).

## Usage

```sh
pnpm dev
```

Copy the template, then edit `XR_OPERATOR_URL` in `.env.local`:

```sh
cp .env.example .env.local
```

## Development

Requires Node.js 22.18 or newer and pnpm 12.10.1.

```sh
pnpm install
pnpm build
pnpm test
```
