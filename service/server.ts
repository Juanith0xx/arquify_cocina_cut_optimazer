import express from 'express';
import { optimizeNesting } from './src/utils/nesting.js';

const app = express();

const PORT = Number(process.env.PORT || 3001);

app.use(express.json({ limit: '10mb' }));

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: 'arquify-cut-optimizer',
    uptime: process.uptime()
  });
});

app.post('/optimize', (req, res) => {
  try {
    const {
      parts,
      sheetWidth = 1830,
      sheetHeight = 2500,
      kerf = 4,
      margin = 15
    } = req.body ?? {};

    if (!Array.isArray(parts)) {
      return res.status(400).json({
        success: false,
        error: 'Se requiere una lista de piezas'
      });
    }

    if (
      ![sheetWidth, sheetHeight, kerf, margin].every(
        value => typeof value === 'number' && Number.isFinite(value)
      ) ||
      sheetWidth <= 0 ||
      sheetHeight <= 0 ||
      kerf < 0 ||
      margin < 0 ||
      margin * 2 >= Math.min(sheetWidth, sheetHeight)
    ) {
      return res.status(400).json({
        success: false,
        error: 'Dimensiones o parámetros de corte inválidos'
      });
    }


    // Validar las dimensiones originales antes del corte.
    const usableWidth = sheetWidth - margin * 2;
    const usableHeight = sheetHeight - margin * 2;
    const ids = new Set<string>();

    for (const part of parts) {
      if (
        !part ||
        typeof part.id !== 'string' ||
        !part.id.trim() ||
        ids.has(part.id) ||
        !Number.isFinite(part.width) ||
        !Number.isFinite(part.length) ||
        part.width <= 0 ||
        part.length <= 0 ||
        !Number.isSafeInteger(part.qty) ||
        part.qty <= 0 ||
        (part.allowRotation !== undefined &&
         typeof part.allowRotation !== 'boolean')
      ) {
        return res.status(400).json({
          success: false,
          error: 'Datos de pieza inválidos o ID duplicado',
          partId: part?.id ?? null
        });
      }

      ids.add(part.id);

      const normalFits =
        part.length <= usableWidth &&
        part.width <= usableHeight;

      const rotatedFits =
        part.allowRotation !== false &&
        part.width <= usableWidth &&
        part.length <= usableHeight;

      if (!normalFits && !rotatedFits) {
        return res.status(422).json({
          success: false,
          error: 'La pieza no cabe en la placa disponible',
          partId: part.id,
          requested: {
            width: part.width,
            length: part.length
          },
          usableSheet: {
            width: usableWidth,
            height: usableHeight
          }
        });
      }
    }

    // Separar piezas por color antes de optimizar.
    // Cada grupo debe ocupar placas independientes.
    const groups = new Map<string, typeof parts>();

    for (const part of parts) {
      if (typeof part?.color !== 'string' || !part.color.trim()) {
        return res.status(400).json({
          success: false,
          error: 'Cada pieza debe tener un color válido'
        });
      }

      const key = part.color.trim().toLowerCase();
      const group = groups.get(key) ?? [];
      group.push(part);
      groups.set(key, group);
    }

    let nextBoardId = 0;

    const result = Array.from(groups.values()).flatMap(group => {
      const boards = optimizeNesting(
        group,
        sheetWidth,
        sheetHeight,
        kerf,
        margin
      );

      return boards.map(board => ({
        ...board,
        id: ++nextBoardId,
        color: group[0].color
      }));
    });


    // Comprobar que el algoritmo no recortó ni omitió piezas.
    const expected = new Map<string, any>();

    for (const part of parts) {
      for (let i = 0; i < part.qty; i++) {
        expected.set(`${part.id}-${i}`, part);
      }
    }

    const seen = new Set<string>();

    for (const board of result) {
      for (const placed of board.placedParts) {
        const original = expected.get(placed.id);

        if (!original || seen.has(placed.id)) {
          return res.status(422).json({
            success: false,
            error: 'Pieza desconocida o duplicada en el resultado',
            partId: placed.id
          });
        }

        seen.add(placed.id);

        const normal =
          Math.abs(placed.w - original.length) < 0.01 &&
          Math.abs(placed.h - original.width) < 0.01;

        const rotated =
          original.allowRotation !== false &&
          Math.abs(placed.w - original.width) < 0.01 &&
          Math.abs(placed.h - original.length) < 0.01;

        if (!normal && !rotated) {
          return res.status(422).json({
            success: false,
            error: 'El algoritmo modificó las dimensiones originales',
            partId: placed.id,
            calculated: { width: placed.w, height: placed.h }
          });
        }
      }
    }

    if (seen.size !== expected.size) {
      return res.status(422).json({
        success: false,
        error: 'La optimización dejó piezas sin distribuir',
        expectedParts: expected.size,
        placedParts: seen.size
      });
    }

    res.json({
      success: true,
      result,
      timestamp: new Date().toISOString()
    });

  } catch (error) {
    console.error('Error Cut Optimizer:', error);

    res.status(500).json({
      success: false,
      error: 'Error interno al optimizar el corte'
    });
  }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Cut Optimizer escuchando en puerto ${PORT}`);
});
