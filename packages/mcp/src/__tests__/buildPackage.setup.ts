// Builds dist/ once before the tests, so they exercise the files the package ships.
import { buildPackage } from '../../build.ts';

export default async function setup(): Promise<void> {
  await buildPackage();
}
