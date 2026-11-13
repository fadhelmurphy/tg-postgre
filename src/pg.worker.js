// PGlite berjalan di Web Worker supaya query berat tidak membekukan UI.
import { PGlite } from '@electric-sql/pglite';
import { worker } from '@electric-sql/pglite/worker';

worker({ async init(options) { return new PGlite(options); } });
