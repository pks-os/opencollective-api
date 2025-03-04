import express from 'express';
import { GraphQLBoolean, GraphQLEnumType, GraphQLInt, GraphQLList, GraphQLNonNull, GraphQLString } from 'graphql';
import { GraphQLDateTime } from 'graphql-scalars';
import { compact } from 'lodash';
import { Includeable, Order } from 'sequelize';

import OrderStatuses from '../../../../constants/order-status';
import { buildSearchConditions } from '../../../../lib/sql-search';
import models, { Op, sequelize } from '../../../../models';
import { checkScope } from '../../../common/scope-check';
import { NotFound, Unauthorized } from '../../../errors';
import { GraphQLOrderCollection } from '../../collection/OrderCollection';
import { GraphQLAccountOrdersFilter } from '../../enum/AccountOrdersFilter';
import { GraphQLContributionFrequency } from '../../enum/ContributionFrequency';
import { GraphQLOrderPausedBy } from '../../enum/OrderPausedBy';
import { GraphQLOrderStatus } from '../../enum/OrderStatus';
import { GraphQLPaymentMethodService } from '../../enum/PaymentMethodService';
import { GraphQLPaymentMethodType } from '../../enum/PaymentMethodType';
import { fetchAccountWithReference, GraphQLAccountReferenceInput } from '../../input/AccountReferenceInput';
import {
  CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  GraphQLChronologicalOrderInput,
} from '../../input/ChronologicalOrderInput';
import {
  fetchPaymentMethodWithReference,
  GraphQLPaymentMethodReferenceInput,
} from '../../input/PaymentMethodReferenceInput';
import { getDatabaseIdFromTierReference, GraphQLTierReferenceInput } from '../../input/TierReferenceInput';
import { CollectionArgs, CollectionReturnType } from '../../interface/Collection';

type OrderAssociation = 'fromCollective' | 'collective';

// Returns the join condition for association
const getJoinCondition = (
  account,
  association: OrderAssociation,
  includeHostedAccounts = false,
  includeChildrenAccounts = false,
): Record<string, unknown> => {
  const associationFields = { collective: 'CollectiveId', fromCollective: 'FromCollectiveId' };
  const field = associationFields[association] || `$${association}.id$`;
  let conditions = [{ [field]: account.id }];

  // Hosted accounts
  if (includeHostedAccounts && account.isHostAccount) {
    // Host are always approved and have a HostCollectiveId
    conditions = [
      {
        [`$${association}.HostCollectiveId$`]: account.id,
        [`$${association}.approvedAt$`]: { [Op.not]: null },
      },
    ];
  }

  // Children collectives
  if (includeChildrenAccounts) {
    conditions.push({ [`$${association}.ParentCollectiveId$`]: account.id });
  }

  return conditions.length === 1 ? conditions[0] : { [Op.or]: conditions };
};

export const OrdersCollectionArgs = {
  limit: { ...CollectionArgs.limit, defaultValue: 100 },
  offset: CollectionArgs.offset,
  includeHostedAccounts: {
    type: GraphQLBoolean,
    description: 'If account is a host, also include hosted accounts orders',
  },
  includeChildrenAccounts: {
    type: new GraphQLNonNull(GraphQLBoolean),
    description: 'Include orders from children events/projects',
    defaultValue: false,
  },
  pausedBy: {
    type: new GraphQLList(GraphQLOrderPausedBy),
    description: 'Only return orders that were paused by these roles. status must be set to PAUSED.',
  },
  paymentMethod: {
    type: GraphQLPaymentMethodReferenceInput,
    description:
      'Only return orders that were paid with this payment method. Must be an admin of the account owning the payment method.',
  },
  paymentMethodService: {
    type: new GraphQLList(GraphQLPaymentMethodService),
    description: 'Only return orders that match these payment method services',
  },
  paymentMethodType: {
    type: new GraphQLList(GraphQLPaymentMethodType),
    description: 'Only return orders that match these payment method types',
  },
  includeIncognito: {
    type: GraphQLBoolean,
    description: 'Whether to include incognito orders. Must be admin or root. Only with filter null or OUTGOING.',
    defaultValue: false,
  },
  filter: {
    type: GraphQLAccountOrdersFilter,
    description: 'Account orders filter (INCOMING or OUTGOING)',
  },
  frequency: {
    type: new GraphQLList(GraphQLContributionFrequency),
    description: 'Use this field to filter orders on their frequency (ONETIME, MONTHLY or YEARLY)',
  },
  status: {
    type: new GraphQLList(GraphQLOrderStatus),
    description: 'Use this field to filter orders on their statuses',
  },
  orderBy: {
    type: new GraphQLNonNull(GraphQLChronologicalOrderInput),
    description: 'The order of results',
    defaultValue: CHRONOLOGICAL_ORDER_INPUT_DEFAULT_VALUE,
  },
  minAmount: {
    type: GraphQLInt,
    description: 'Only return orders where the amount is greater than or equal to this value (in cents)',
  },
  maxAmount: {
    type: GraphQLInt,
    description: 'Only return orders where the amount is lower than or equal to this value (in cents)',
  },
  dateFrom: {
    type: GraphQLDateTime,
    description: 'Only return orders that were created after this date',
  },
  dateTo: {
    type: GraphQLDateTime,
    description: 'Only return orders that were created before this date',
  },
  expectedDateFrom: {
    type: GraphQLDateTime,
    description: 'Only return pending orders that were expected after this date',
  },
  expectedDateTo: {
    type: GraphQLDateTime,
    description: 'Only return pending orders that were expected before this date',
  },
  chargedDateFrom: {
    type: GraphQLDateTime,
    description: 'Return orders that were charged after this date',
  },
  chargedDateTo: {
    type: GraphQLDateTime,
    description: 'Return orders that were charged before this date',
  },
  searchTerm: {
    type: GraphQLString,
    description: 'The term to search',
  },
  tierSlug: {
    type: GraphQLString,
    deprecationReason: '2022-02-25: Should be replaced by a tier reference. Not existing yet.',
  },
  tier: {
    type: new GraphQLList(GraphQLTierReferenceInput),
  },
  onlySubscriptions: {
    type: GraphQLBoolean,
    description: `Only returns orders that have a subscription (monthly/yearly). Don't use together with frequency.`,
  },
  onlyActiveSubscriptions: {
    type: GraphQLBoolean,
    description: `Same as onlySubscriptions, but returns only orders with active subscriptions`,
  },
  expectedFundsFilter: {
    type: new GraphQLEnumType({
      name: 'ExpectedFundsFilter',
      description: 'Expected funds filter (ALL_EXPECTED_FUNDS, ONLY_PENDING, ONLY_MANUAL)',
      values: {
        ALL_EXPECTED_FUNDS: {},
        ONLY_PENDING: {},
        ONLY_MANUAL: {},
      },
    }),
  },
  oppositeAccount: {
    type: GraphQLAccountReferenceInput,
    description:
      'Return only orders made from/to that opposite account (only works when orders are already filtered with a main account)',
  },
};

export const OrdersCollectionResolver = async (args, req: express.Request) => {
  const where = { [Op.and]: [] };
  const include: Includeable[] = [
    { association: 'fromCollective', required: true, attributes: [] },
    { association: 'collective', required: true, attributes: [] },
    { model: models.Subscription, required: false, attributes: [] },
  ];

  // Check Pagination arguments
  if (args.limit <= 0) {
    args.limit = 100;
  }
  if (args.offset <= 0) {
    args.offset = 0;
  }
  if (args.limit > 1000 && !req.remoteUser?.isRoot()) {
    throw new Error('Cannot fetch more than 1,000 orders at the same time, please adjust the limit');
  }

  let account, oppositeAccount;

  // Load accounts
  if (args.account) {
    const fetchAccountParams = { loaders: req.loaders, throwIfMissing: true };
    account = await fetchAccountWithReference(args.account, fetchAccountParams);

    // Load opposite account
    if (args.oppositeAccount) {
      oppositeAccount = await fetchAccountWithReference(args.oppositeAccount, fetchAccountParams);
    }

    const accountConditions = [];
    const oppositeAccountConditions = [];

    // Filter on fromCollective
    if (!args.filter || args.filter === 'OUTGOING') {
      accountConditions.push(
        getJoinCondition(account, 'fromCollective', args.includeHostedAccounts, args.includeChildrenAccounts),
      );
      if (oppositeAccount) {
        oppositeAccountConditions.push(getJoinCondition(oppositeAccount, 'collective'));
      }
      if (args.includeIncognito) {
        // Needs to be root or admin of the profile to see incognito orders
        if (
          (req.remoteUser?.isAdminOfCollective(account) && checkScope(req, 'incognito')) ||
          (req.remoteUser?.isRoot() && checkScope(req, 'root'))
        ) {
          const incognitoProfile = await account.getIncognitoProfile();
          if (incognitoProfile) {
            accountConditions.push(getJoinCondition(incognitoProfile, 'fromCollective'));
          }
        } else {
          // Is this desirable? Some current tests don't like it.
          // throw new Error('Only admins and root can fetch incognito orders');
        }
      }
    }

    // Filter on collective
    if (!args.filter || args.filter === 'INCOMING') {
      accountConditions.push(
        getJoinCondition(account, 'collective', args.includeHostedAccounts, args.includeChildrenAccounts),
      );
      if (oppositeAccount) {
        oppositeAccountConditions.push(getJoinCondition(oppositeAccount, 'fromCollective'));
      }
    }

    // Bind account conditions to the query
    where[Op.and].push(accountConditions.length === 1 ? accountConditions : { [Op.or]: accountConditions });
    if (oppositeAccountConditions.length > 0) {
      where[Op.and].push(
        oppositeAccountConditions.length === 1 ? oppositeAccountConditions : { [Op.or]: oppositeAccountConditions },
      );
    }
  }

  // Load payment method
  if (args.paymentMethod) {
    const paymentMethod = await fetchPaymentMethodWithReference(args.paymentMethod, {
      sequelizeOpts: { attributes: ['id'], include: [{ model: models.Collective }] },
    });
    if (!req.remoteUser?.isAdminOfCollective(paymentMethod.Collective)) {
      throw new Unauthorized('You must be an admin of the payment method to fetch its orders');
    }
    where['PaymentMethodId'] = paymentMethod.id;
  }

  // Filter on payment method service/type
  if (args.paymentMethodService || args.paymentMethodType) {
    const paymentMethodInclude = { association: 'paymentMethod', required: true, where: {} };
    if (args.paymentMethodService) {
      paymentMethodInclude.where['service'] = args.paymentMethodService;
    }
    if (args.paymentMethodType) {
      paymentMethodInclude.where['type'] = args.paymentMethodType;
    }
    include.push(paymentMethodInclude);
  }

  const isHostAdmin =
    account?.isHostAccount && args.includeHostedAccounts && req.remoteUser?.isAdminOfCollective(account);

  // Add search filter
  const searchTermConditions = buildSearchConditions(args.searchTerm, {
    idFields: ['id'],
    slugFields: ['$fromCollective.slug$', '$collective.slug$'],
    textFields: [
      '$fromCollective.name$',
      '$collective.name$',
      'description',
      'data.ponumber',
      'data.fromAccountInfo.name',
      'data.fromAccountInfo.email',
    ],
    emailFields: isHostAdmin ? ['$createdByUser.email$'] : [],
    amountFields: ['totalAmount'],
    stringArrayFields: ['tags'],
    stringArrayTransformFn: (str: string) => str.toLowerCase(), // expense tags are stored lowercase
  });

  if (searchTermConditions.length) {
    where[Op.and].push({ [Op.or]: searchTermConditions });
    if (
      searchTermConditions.some(conditionals => Object.keys(conditionals).some(key => key.includes('createdByUser')))
    ) {
      include.push({
        association: 'createdByUser',
        attributes: [],
      });
    }
  }

  // Add filters
  if (args.minAmount) {
    where['totalAmount'] = { [Op.gte]: args.minAmount };
  }
  if (args.maxAmount) {
    where['totalAmount'] = { ...where['totalAmount'], [Op.lte]: args.maxAmount };
  }
  if (args.dateFrom) {
    where['createdAt'] = { [Op.gte]: args.dateFrom };
  }
  if (args.dateTo) {
    where['createdAt'] = where['createdAt'] || {};
    where['createdAt'][Op.lte] = args.dateTo;
  }
  if (args.expectedDateFrom) {
    where['data.expectedAt'] = { [Op.gte]: args.expectedDateFrom };
  }
  if (args.expectedDateTo) {
    where['data.expectedAt'] = where['data.expectedAt'] || {};
    where['data.expectedAt'][Op.lte] = args.expectedDateTo;
  }

  if (args.chargedDateFrom) {
    where[Op.and].push(
      sequelize.where(sequelize.literal(`COALESCE("Subscription"."lastChargedAt", "Order"."createdAt")`), {
        [Op.gte]: args.chargedDateFrom,
      }),
    );
  }
  if (args.chargedDateTo) {
    where[Op.and].push(
      sequelize.where(sequelize.literal(`COALESCE("Subscription"."lastChargedAt", "Order"."createdAt")`), {
        [Op.lte]: args.chargedDateTo,
      }),
    );
  }

  if (args.status && args.status.length > 0) {
    where['status'] = { [Op.in]: args.status };
    if (args.status.includes(OrderStatuses.PAUSED) && args.pausedBy) {
      where['data.pausedBy'] = { [Op.in]: args.pausedBy };
    }
  }

  if (args.tier) {
    const tierIds = args.tier.map(getDatabaseIdFromTierReference);
    include.push({ association: 'Tier', required: true, where: { id: { [Op.in]: tierIds } } });
  }

  if (args.frequency) {
    if (args.frequency.includes('ONETIME')) {
      where['SubscriptionId'] = { [Op.is]: null };
    } else {
      const intervals = compact([
        args.frequency.includes('MONTHLY') && 'month',
        args.frequency.includes('YEARLY') && 'year',
      ]);
      where[Op.and].push({
        ['$Subscription.interval$']: { [Op.in]: intervals },
      });
    }
  } else if (args.onlySubscriptions) {
    where[Op.and].push({
      [Op.or]: [
        { ['$Subscription.id$']: { [Op.ne]: null } },
        { interval: { [Op.in]: ['year', 'month'] }, status: 'PROCESSING' },
      ],
    });
  } else if (args.onlyActiveSubscriptions) {
    where[Op.and].push({
      ['$Subscription.isActive$']: true,
    });
  }

  if (args.tierSlug) {
    if (!account) {
      throw new NotFound('tierSlug can only be used when an account is specified');
    }
    const tierSlug = args.tierSlug.toLowerCase();
    const tier = await models.Tier.findOne({ where: { CollectiveId: account.id, slug: tierSlug } });
    if (!tier) {
      throw new NotFound('tierSlug Not Found');
    }
    where['TierId'] = tier.id;
  }

  // use 'true' literal to avoid casting and allow index use when sequelize generates these nested json queries
  if (args.expectedFundsFilter) {
    if (args.expectedFundsFilter === 'ONLY_MANUAL') {
      where['data.isManualContribution'] = 'true';
    } else if (args.expectedFundsFilter === 'ONLY_PENDING') {
      where['data.isPendingContribution'] = 'true';
    } else {
      where[Op.or] = where[Op.or] || {};
      where[Op.or]['data.isPendingContribution'] = 'true';
      where[Op.or]['data.isManualContribution'] = 'true';
    }
  } else if (!where['status']) {
    where['status'] = { ...where['status'], [Op.ne]: OrderStatuses.PENDING };
  }

  let order: Order;
  if (args.orderBy.field === 'lastChargedAt') {
    order = [
      [sequelize.literal(`COALESCE("Subscription"."lastChargedAt", "Order"."createdAt")`), args.orderBy.direction],
    ];
  } else {
    order = [[args.orderBy.field, args.orderBy.direction]];
  }
  const { offset, limit } = args;
  return {
    nodes: () => models.Order.findAll({ include, where, order, offset, limit }),
    totalCount: () => models.Order.count({ include, where }),
    limit: args.limit,
    offset: args.offset,
  };
};

// Using a generator to avoid circular dependencies (OrderCollection -> Order -> PaymentMethod -> OrderCollection -> ...)
const getOrdersCollectionQuery = () => ({
  type: new GraphQLNonNull(GraphQLOrderCollection),
  args: {
    account: {
      type: GraphQLAccountReferenceInput,
      description: 'Return only orders made from/to account',
    },
    ...OrdersCollectionArgs,
  },
  async resolve(_: void, args, req: express.Request): Promise<CollectionReturnType> {
    return OrdersCollectionResolver(args, req);
  },
});

export default getOrdersCollectionQuery;
