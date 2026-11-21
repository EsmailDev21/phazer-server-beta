import { Injectable } from '@nestjs/common';
import {
  CorrectionType,
  SnapActionType,
  SnapReviewStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { QuerySnapAccuracyDto } from './dto/query-analytics.dto';

const CONFIDENCE_BUCKETS = [
  { label: '0.0-0.2', min: 0, max: 0.2 },
  { label: '0.2-0.4', min: 0.2, max: 0.4 },
  { label: '0.4-0.6', min: 0.4, max: 0.6 },
  { label: '0.6-0.8', min: 0.6, max: 0.8 },
  { label: '0.8-1.0', min: 0.8, max: 1.01 }, // inclusive upper bound
];

/**
 * SCOPING DECISION, documented since the graph doesn't say explicitly:
 * these are scoped to the CURRENT USER's own sessions, same as
 * GET /snap/sessions, not a global cross-user aggregate. Individual
 * correction patterns could be sensitive in aggregate, and there's no
 * stated need for any authenticated user to see platform-wide model
 * performance — that's better served by a separate admin/service-scoped
 * endpoint if the pipeline project needs it for model improvement.
 *
 * "per model" mapping, since no schema signal marks WHICH model's output
 * a given correction was actually blaming:
 *   m1 (segmentation): approximated via REJECTED clauses (no other
 *     available signal) bucketed by m1Confidence.
 *   m2 (action classification): correctedAction set AND differs from
 *     predictedAction, OR REJECTED — bucketed by actionConfidence.
 *   m3 (entity extraction): correctionType IN (PAYLOAD_ONLY, FULL_CORRECTION)
 *     — bucketed by entityConfidence.
 * These are reasonable approximations given the actual stored data, not
 * a literal schema field — documented rather than presented as exact.
 */
@Injectable()
export class SnapAnalyticsService {
  constructor(private readonly prisma: PrismaService) {}

  async getAccuracy(userId: string, query: QuerySnapAccuracyDto) {
    const clauses = await this.prisma.snapClause.findMany({
      where: {
        session: { userId },
        ...(query.action && { predictedAction: query.action }),
      },
      select: {
        predictedAction: true,
        correctedAction: true,
        correctionType: true,
        reviewStatus: true,
        m1Confidence: true,
        actionConfidence: true,
        entityConfidence: true,
      },
    });

    const model = query.model ?? 'm2';
    const confidenceField =
      model === 'm1'
        ? 'm1Confidence'
        : model === 'm3'
          ? 'entityConfidence'
          : 'actionConfidence';

    const buckets = CONFIDENCE_BUCKETS.map((bucket) => {
      const inBucket = clauses.filter((c) => {
        const confidence = c[confidenceField];
        return (
          confidence !== null &&
          confidence >= bucket.min &&
          confidence < bucket.max
        );
      });

      const wasWrong = inBucket.filter((c) => {
        if (model === 'm1') return c.reviewStatus === SnapReviewStatus.REJECTED;
        if (model === 'm3') {
          return (
            c.correctionType === CorrectionType.PAYLOAD_ONLY ||
            c.correctionType === CorrectionType.FULL_CORRECTION
          );
        }
        // m2
        return (
          c.reviewStatus === SnapReviewStatus.REJECTED ||
          (c.correctedAction !== null &&
            c.correctedAction !== c.predictedAction)
        );
      });

      return {
        confidenceRange: bucket.label,
        sampleSize: inBucket.length,
        correctionRate:
          inBucket.length === 0
            ? null
            : Math.round((wasWrong.length / inBucket.length) * 100) / 100,
      };
    });

    return { model, action: query.action ?? null, buckets };
  }

  async getCorrections(userId: string) {
    const clauses = await this.prisma.snapClause.findMany({
      where: {
        session: { userId },
        reviewStatus: SnapReviewStatus.CORRECTED,
      },
      select: {
        predictedAction: true,
        correctedAction: true,
        extractedEntities: true,
        correctedEntities: true,
        correctionType: true,
      },
    });

    // Most-confused action pairs
    const pairCounts = new Map<
      string,
      { predicted: SnapActionType; corrected: SnapActionType; count: number }
    >();
    for (const c of clauses) {
      if (
        !c.predictedAction ||
        !c.correctedAction ||
        c.predictedAction === c.correctedAction
      )
        continue;
      const key = `${c.predictedAction}->${c.correctedAction}`;
      const existing = pairCounts.get(key);
      if (existing) {
        existing.count += 1;
      } else {
        pairCounts.set(key, {
          predicted: c.predictedAction,
          corrected: c.correctedAction,
          count: 1,
        });
      }
    }
    const mostConfusedActionPairs = Array.from(pairCounts.values())
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    // Most-missed entity types — approximated as: which keys most often
    // differ between extractedEntities and correctedEntities, for
    // clauses where the entity payload itself was corrected. Not a
    // literal schema field — a derived interpretation of the stored JSON.
    const keyMissCounts = new Map<string, number>();
    for (const c of clauses) {
      if (
        c.correctionType !== CorrectionType.PAYLOAD_ONLY &&
        c.correctionType !== CorrectionType.FULL_CORRECTION
      )
        continue;
      const extracted =
        (c.extractedEntities as Record<string, unknown> | null) ?? {};
      const corrected =
        (c.correctedEntities as Record<string, unknown> | null) ?? {};
      const allKeys = new Set([
        ...Object.keys(extracted),
        ...Object.keys(corrected),
      ]);
      for (const key of allKeys) {
        if (JSON.stringify(extracted[key]) !== JSON.stringify(corrected[key])) {
          keyMissCounts.set(key, (keyMissCounts.get(key) ?? 0) + 1);
        }
      }
    }
    const mostMissedEntityTypes = Array.from(keyMissCounts.entries())
      .map(([entityKey, count]) => ({ entityKey, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10);

    return { mostConfusedActionPairs, mostMissedEntityTypes };
  }
}
