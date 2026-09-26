# Esquema da BD Multipark (só estrutura)

Gerado por `scripts/multipark-db-schema.ts` em 2026-09-26T21:25:06.050Z · PostgreSQL 17.11 (Debian 17.11-1.pgdg13+2) · 81 tabela(s).

Sem dados: só tabelas, colunas, chaves, índices, enums e contagens APROXIMADAS (estatísticas do motor). Voltar a gerar depois de migrações da Multipark.

## Tabelas

| Tabela | Linhas (aprox.) | Colunas | PK |
|---|---:|---:|---|
| [_prisma_migrations](#_prisma_migrations) | 110 | 8 | id |
| [AccountDeletionRequest](#accountdeletionrequest) | ? | 21 | id |
| [ActivityEvent](#activityevent) | 8490 | 26 | id |
| [Agent](#agent) | 2238 | 113 | id |
| [AgentInvite](#agentinvite) | 118 | 119 | id |
| [AggregatorProcessedEvent](#aggregatorprocessedevent) | 51 | 8 | id |
| [AggregatorQuarantineItem](#aggregatorquarantineitem) | 9 | 14 | id |
| [AiConversation](#aiconversation) | ? | 7 | id |
| [AiEmailMessage](#aiemailmessage) | 2792 | 29 | id |
| [AiEmailSyncState](#aiemailsyncstate) | 1 | 7 | mailbox |
| [AiMessage](#aimessage) | ? | 9 | id |
| [Allocation](#allocation) | 38 | 9 | id |
| [Allowance](#allowance) | ? | 19 | id |
| [ApiKey](#apikey) | 38 | 19 | id |
| [ArticleComment](#articlecomment) | ? | 12 | id |
| [ArticleFavourite](#articlefavourite) | ? | 6 | id |
| [ArticleReview](#articlereview) | ? | 8 | id |
| [Attachment](#attachment) | 1497 | 6 | id |
| [Billing](#billing) | 8652 | 16 | id |
| [Booking](#booking) | 67 747 | 105 | id |
| [BookingDraft](#bookingdraft) | 745 | 9 | id |
| [BookingExtraService](#bookingextraservice) | 23 486 | 7 | id |
| [BookingFee](#bookingfee) | ? | 6 | id |
| [BookingPaymentLink](#bookingpaymentlink) | 86 | 16 | id |
| [BookingPricing](#bookingpricing) | 92 791 | 10 | id |
| [BookingPricingPayment](#bookingpricingpayment) | 39 693 | 5 | id |
| [BookingReview](#bookingreview) | 205 | 9 | id |
| [BookingVehicle](#bookingvehicle) | 65 213 | 9 | id |
| [Campaign](#campaign) | 41 | 19 | id |
| [CampaignDeliveryType](#campaigndeliverytype) | 118 | 9 | id |
| [CampaignExtraFee](#campaignextrafee) | ? | 4 | id |
| [CampaignExtraService](#campaignextraservice) | 339 | 5 | id |
| [CampaignPricing](#campaignpricing) | 123 | 6 | id |
| [Cancellation](#cancellation) | 1091 | 11 | id |
| [ChatMessage](#chatmessage) | 2210 | 12 | id |
| [Client](#client) | 45 935 | 15 | id |
| [ClientPlan](#clientplan) | 14 | 34 | id |
| [ClientPlanAttachment](#clientplanattachment) | ? | 6 | id |
| [ClientPlanPayment](#clientplanpayment) | 63 | 27 | id |
| [ClientPlanPendingPeriod](#clientplanpendingperiod) | ? | 14 | id |
| [CommunityArticle](#communityarticle) | 2 | 23 | id |
| [ConnectionDelivery](#connectiondelivery) | 8260 | 13 | id |
| [ConnectionEndpoint](#connectionendpoint) | 51 | 13 | id |
| [ConnectionExternalRef](#connectionexternalref) | ? | 6 | id |
| [Credit](#credit) | 273 | 6 | id |
| [DeliveryType](#deliverytype) | 68 | 9 | id |
| [Driver](#driver) | 48 | 6 | id |
| [EmailTemplate](#emailtemplate) | 88 | 10 | id |
| [EntityEmailLog](#entityemaillog) | 6404 | 10 | id |
| [EntityNote](#entitynote) | 220 | 10 | id |
| [EntitySettlement](#entitysettlement) | 195 | 14 | id |
| [ExtraFee](#extrafee) | 4 | 4 | id |
| [ExtraService](#extraservice) | 207 | 7 | id |
| [Garage](#garage) | 21 | 8 | id |
| [History](#history) | 280 588 | 13 | id |
| [Notification](#notification) | 27 933 | 13 | id |
| [Occurrence](#occurrence) | 1764 | 16 | id |
| [OperatingHours](#operatinghours) | 245 | 5 | id |
| [Park](#park) | 55 | 66 | id |
| [ParkAvailabilityBlock](#parkavailabilityblock) | ? | 13 | id |
| [ParkInviteRequest](#parkinviterequest) | ? | 8 | id |
| [Partner](#partner) | 462 | 20 | id |
| [PartnerAttachment](#partnerattachment) | ? | 6 | id |
| [PartnerCommission](#partnercommission) | ? | 3 | id |
| [PartnerCreditEntry](#partnercreditentry) | ? | 10 | id |
| [PartnerMember](#partnermember) | ? | 27 | id |
| [PartnerPayment](#partnerpayment) | 5 | 16 | id |
| [PartnerPaymentSplit](#partnerpaymentsplit) | ? | 14 | id |
| [Pricing](#pricing) | 144 | 6 | id |
| [Procedures](#procedures) | 110 | 4 | id |
| [ProClient](#proclient) | 61 | 11 | id |
| [ProClientAttachment](#proclientattachment) | 209 | 6 | id |
| [ProPayment](#propayment) | 22 | 16 | id |
| [SavedBookingFilter](#savedbookingfilter) | 2 | 9 | id |
| [Spot](#spot) | 1641 | 9 | id |
| [Submerchant](#submerchant) | 25 | 16 | id |
| [Subscription](#subscription) | 1449 | 45 | id |
| [SubscriptionPayment](#subscriptionpayment) | 10 | 14 | id |
| [UserPreference](#userpreference) | 94 | 4 | userId |
| [Vehicle](#vehicle) | 10 879 | 11 | id |
| [WebsiteCheckout](#websitecheckout) | 594 | 20 | id |

## Enums

- **AccountDeletionStatus**: `SCHEDULED`, `EXECUTING`, `COMPLETED`, `CANCELLED`, `FAILED`
- **AgentRoleType**: `ADMIN`, `SUPERVISOR`, `ACCOUNTANT`, `DRIVER`, `JUNIOR`, `PARTNER`, `LEADER`
- **AggregatorQuarantineReason**: `MATRIX_MISSING`, `AMOUNT_DUE`, `VALIDATION_FAILED`, `PARSE_FAILED`, `TARGET_NOT_FOUND`, `INGEST_FAILED`
- **AggregatorQuarantineStatus**: `PENDING`, `RESOLVED`, `DISCARDED`
- **AggregatorSource**: `PARKVIA`
- **AiChatProfile**: `GERAL`
- **AiEmailCategory**: `RESERVA`, `RECLAMACAO`, `PARCEIRO`, `FINANCEIRO`, `OUTRO`
- **AiEmailStatus**: `PENDENTE`, `RESPONDIDO`, `ARQUIVADO`
- **AiMessageRole**: `USER`, `ASSISTANT`
- **AllowanceCadence**: `DAY`, `WEEK`, `MONTH`, `YEAR`
- **AllowanceStatus**: `ACTIVE`, `INACTIVE`
- **AllowanceType**: `PUBLIC`, `CLIENT`
- **ApiKeyStatus**: `ACTIVE`, `REVOKED`, `EXPIRED`
- **ArticleAuthorType**: `ADMIN`, `CLIENT`
- **ArticleLocale**: `pt-PT`, `en-US`, `es-ES`
- **ArticleSource**: `EDITORIAL`, `COMMUNITY`
- **ArticleVisibility**: `DRAFT`, `PRIVATE`, `PUBLIC`
- **AttachmentType**: `PAYMENT_PROOF`, `VEHICLE_VIDEO`, `VEHICLE_PHOTO`, `DOCUMENT`, `SIGN_DOCUMENT`, `OTHER`, `INVOICE_WITH_CREDIT_NOTE`, `CREDIT_NOTE`
- **AvailabilityBlockScope**: `ALL_DAYS`, `WEEKDAY`, `DAY_OF_MONTH`, `DATE`, `DATE_RANGE`
- **AvailabilityBlockTarget**: `CHECK_IN`, `CHECK_OUT`, `BOTH`
- **BackofficeViewType**: `VALET`, `PARKING`
- **BookingDraftStatus**: `PENDING`, `FINALIZED`, `EXPIRED`
- **BookingOrigin**: `GENERAL_FORM`, `MANUAL`, `MARKETPLACE`, `IMPORTED`, `API`, `MOBILE_APP`, `PARTNER_API`, `PARTNER_DASHBOARD`, `CLIENT_PLAN`
- **BookingPaymentLinkStatus**: `PENDING`, `SETTLED`, `FAILED`, `CANCELED`
- **BookingStatus**: `BOOKED`, `CHECKING_IN`, `CHECKED_IN`, `CHECKING_OUT`, `CHECKED_OUT`, `MOVING`, `CANCELLED`, `PENDING`, `PENDING_CHECKOUT`
- **CampaignAccessType**: `PUBLIC`, `LINK_ONLY`, `DISCOUNT_CODE`
- **CampaignStatus**: `DRAFT`, `ACTIVE`, `INACTIVE`, `EXPIRED`
- **ChangeType**: `CHECKING_IN`, `CHECK_IN`, `CHECKING_OUT`, `CHECK_OUT`, `MOVEMENT`, `CANCEL`, `UPDATE`, `CREATED`, `PENDING_CHECKOUT`
- **ChargerPower**: `BASIC`, `NORMAL`, `FAST`
- **ChatSenderRole**: `CLIENT`, `AGENT`, `OWNER`
- **ClientPlanStatus**: `PENDING`, `ACTIVE`, `CANCELLED`, `EXPIRED`, `SUSPENDED`
- **CommentStatus**: `VISIBLE`, `HIDDEN`, `DELETED`
- **ConnectionDeliveryStatus**: `PENDING`, `DELIVERING`, `SUCCESS`, `DEAD`
- **ConnectionDirection**: `OUTBOUND_PUSH`, `INBOUND_PULL`
- **ConnectionEventType**: `BOOKING_CREATED`, `BOOKING_UPDATED`, `BOOKING_CANCELLED`
- **ConnectionProvider**: `GENERIC_WEBHOOK`, `PARKFLOW`, `OPTITRAVEL`
- **DiscountType**: `PERCENTAGE`, `FIXED_AMOUNT`
- **EmailTemplateType**: `CONFIRMATION`, `PICKUP`, `DELIVERY`, `EVALUATION`, `CANCELLATION`, `OTHER`, `FLIGHT_INFO`, `BILLING`
- **EntityType**: `COR`, `SIN`
- **FeeType**: `EXPRESS`, `NIGHT`, `WEEKEND`
- **InviteStatus**: `PENDING`, `ACCEPTED`, `REJECTED`, `EXPIRED`
- **LedgerEntityType**: `BOOKING`, `PRO_CLIENT`, `PARTNER`, `CLIENT_PLAN`
- **MultiparkPlans**: `FREE`, `PROFESSIONAL`, `ENTERPRISE`, `PARTNER`
- **NotificationRecipientType**: `AGENT`, `CLIENT`
- **NotificationType**: `CHAT_MESSAGE`, `PRICE_CHANGED`, `OCCURRENCE_CREATED`, `BOOKING_EDITED`, `ARTICLE_COMMENT`, `ARTICLE_REPLY`, `ARTICLE_HIDDEN`, `BOOKING_CANCELLED`
- **OccurrencePriority**: `LOW`, `MEDIUM`, `HIGH`
- **ParkListingType**: `ON_PLATFORM`, `DIRECTORY`
- **ParkStatus**: `PENDING`, `ACTIVE`, `INACTIVE`
- **ParkType**: `VALET`, `AIRPORT`, `MALL`, `HOTEL`, `OTHER`, `PRIVATE`
- **ParkingType**: `COVERED`, `UNCOVERED`, `INDOOR`, `VIP`
- **PartnerCreditEntryType**: `EARNED`, `APPLIED`
- **PartnerFeeType**: `PERCENTAGE`, `FIXED`
- **PartnerType**: `AGENCY`, `AGGREGATOR`, `PARTNER`
- **PaymentSource**: `STRIPE`, `PARKVIA`, `PARKOS`, `AGGREGATOR_OTHER`, `PARKFLOW`
- **PaymentStatus**: `PENDING`, `COMPLETED`, `FAILED`, `REFUNDED`
- **PlatformSplitStatus**: `SPLIT`, `SKIPPED`, `FAILED`
- **PricingEntryCategory**: `PARKING`, `VALET`, `SERVICE`, `FEE`, `DISCOUNT`, `ADJUSTMENT`
- **PricingType**: `HOUR`, `DAY`, `WEEK`, `MONTH`, `YEAR`
- **SettlementSource**: `AGENT`, `CLIENT`, `AUTO`
- **SubscriptionStatus**: `ACTIVE`, `INACTIVE`, `SUSPENDED`, `CANCELLED`
- **VehicleSize**: `MOTORCYCLE`, `CAR`, `VAN`, `TRUCK`
- **WebsiteCheckoutStatus**: `OPEN`, `BOOKED`, `EXPIRED`

## _prisma_migrations

Linhas (aprox.): 110 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `character varying(36)` | não |  |  |
| checksum | `character varying(64)` | não |  |  |
| finished_at | `timestamp with time zone` | sim |  |  |
| migration_name | `character varying(255)` | não |  |  |
| logs | `text` | sim |  |  |
| rolled_back_at | `timestamp with time zone` | sim |  |  |
| started_at | `timestamp with time zone` | não | `now()` |  |
| applied_steps_count | `integer` | não | `0` |  |

## AccountDeletionRequest

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| authUserId | `text` | não |  |  |
| email | `text` | sim |  |  |
| channel | `text` | não |  |  |
| language | `text` | não | `'pt'::text` |  |
| status | `"AccountDeletionStatus"` | não | `'SCHEDULED'::"AccountDeletionStatus"` |  |
| requestedAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| scheduledFor | `timestamp(3) without time zone` | não |  |  |
| cancelledAt | `timestamp(3) without time zone` | sim |  |  |
| startedAt | `timestamp(3) without time zone` | sim |  |  |
| completedAt | `timestamp(3) without time zone` | sim |  |  |
| attempts | `integer` | não | `0` |  |
| lastError | `text` | sim |  |  |
| blockedReason | `text` | sim |  |  |
| blockedAt | `timestamp(3) without time zone` | sim |  |  |
| clientIds | `jsonb` | sim |  |  |
| resultCounts | `jsonb` | sim |  |  |
| requestedIp | `text` | sim |  |  |
| userAgent | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Índices:
- `AccountDeletionRequest_authUserId_status_idx` ("authUserId", status)
- `AccountDeletionRequest_status_scheduledFor_idx` (status, "scheduledFor")

## ActivityEvent

Linhas (aprox.): 8490 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| schemaVersion | `integer` | não | `1` |  |
| entityType | `text` | não |  |  |
| entityId | `text` | não |  |  |
| entitySecondaryId | `text` | sim |  |  |
| eventType | `text` | não |  |  |
| parkScope | `text[]` | sim | `ARRAY[]::text[]` |  |
| eventPayload | `jsonb` | não |  |  |
| snapshot | `jsonb` | sim |  |  |
| previousSnapshot | `jsonb` | sim |  |  |
| actorId | `text` | sim |  |  |
| actorEmail | `text` | sim |  |  |
| actorDisplayName | `text` | sim |  |  |
| actorRole | `text` | não |  |  |
| timestamp | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| parkTimezone | `text` | sim |  |  |
| ip | `text` | sim |  |  |
| userAgent | `text` | sim |  |  |
| platform | `text` | sim |  |  |
| requestId | `text` | sim |  |  |
| i18nTitleKey | `text` | não |  |  |
| i18nDescriptionKey | `text` | não |  |  |
| i18nDescriptionParams | `jsonb` | sim |  |  |
| retentionClass | `text` | não | `'OPERATIONAL'::text` |  |
| metadata | `jsonb` | sim |  |  |
| remarks | `text` | sim |  |  |

Índices:
- `ActivityEvent_actorId_timestamp_idx` ("actorId", "timestamp")
- `ActivityEvent_entityType_entityId_timestamp_idx` ("entityType", "entityId", "timestamp")
- `ActivityEvent_timestamp_idx` ("timestamp")

## Agent

Linhas (aprox.): 2238 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| userId | `text` | não |  |  |
| parkId | `text` | não |  |  |
| isActive | `boolean` | não | `true` |  |
| blockedBy | `text` | sim |  |  |
| role | `"AgentRoleType"` | não | `'JUNIOR'::"AgentRoleType"` |  |
| allowEditPark | `boolean` | não | `false` |  |
| allowEditGarage | `boolean` | não | `false` |  |
| allowCreateGarage | `boolean` | não | `false` |  |
| allowViewGarages | `boolean` | não | `false` |  |
| allowCreateBooking | `boolean` | não | `false` |  |
| allowEditBooking | `boolean` | não | `false` |  |
| allowEditBookingStatus | `boolean` | não | `false` |  |
| allowEditBookingPrice | `boolean` | não | `false` |  |
| allowExportBooking | `boolean` | não | `false` |  |
| allowBulkImportBookings | `boolean` | não | `false` |  |
| allowViewBookingPage | `boolean` | não | `false` |  |
| allowViewBookingBooked | `boolean` | não | `false` |  |
| allowViewBookingCheckingIn | `boolean` | não | `false` |  |
| allowViewBookingCheckedIn | `boolean` | não | `false` |  |
| allowViewBookingMoving | `boolean` | não | `false` |  |
| allowViewBookingCheckingOut | `boolean` | não | `false` |  |
| allowViewBookingCheckedOut | `boolean` | não | `false` |  |
| allowViewBookingCancelled | `boolean` | não | `false` |  |
| allowCheckinBooking | `boolean` | não | `false` |  |
| allowCheckoutBooking | `boolean` | não | `false` |  |
| allowMoveBooking | `boolean` | não | `false` |  |
| allowCancelBooking | `boolean` | não | `false` |  |
| allowAssignBookingSpace | `boolean` | não | `false` |  |
| allowAssignBookingSpot | `boolean` | não | `false` |  |
| allowPrintBooking | `boolean` | não | `false` |  |
| allowStatsView | `boolean` | não | `false` |  |
| allowCashboxView | `boolean` | não | `false` |  |
| allowProcessesView | `boolean` | não | `false` |  |
| allowOccurrencesView | `boolean` | não | `false` |  |
| allowCreateOccurrence | `boolean` | não | `false` |  |
| allowEditOccurrence | `boolean` | não | `false` |  |
| allowExportOccurrences | `boolean` | não | `false` |  |
| allowAgentsView | `boolean` | não | `false` |  |
| allowViewAgentPage | `boolean` | não | `false` |  |
| allowCreateAgent | `boolean` | não | `false` |  |
| allowEditAgent | `boolean` | não | `false` |  |
| allowExportAgentHistory | `boolean` | não | `false` |  |
| allowSettingsView | `boolean` | não | `false` |  |
| allowEditSettings | `boolean` | não | `false` |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| allowViewBookingHistory | `boolean` | não | `false` |  |
| allowViewBookingPending | `boolean` | não | `false` |  |
| allowEditParkSettings | `boolean` | não | `false` |  |
| allowViewBookingPrice | `boolean` | não | `false` |  |
| allowCreateApiKeys | `boolean` | não | `false` |  |
| allowViewApiKeys | `boolean` | não | `false` |  |
| allowViewCampaigns | `boolean` | não | `false` |  |
| allowCreateCampaigns | `boolean` | não | `false` |  |
| allowEditApiKeys | `boolean` | não | `false` |  |
| allowEditCampaigns | `boolean` | não | `false` |  |
| allowEditEmail | `boolean` | não | `false` |  |
| allowEmailView | `boolean` | não | `false` |  |
| allowCashValidation | `boolean` | não | `false` |  |
| allowCloseCashier | `boolean` | não | `false` |  |
| allowDriverValidation | `boolean` | não | `false` |  |
| autoDeactivateAt | `timestamp(3) without time zone` | sim |  |  |
| allowCallClient | `boolean` | não | `false` |  |
| allowCheckingInBooking | `boolean` | não | `false` |  |
| allowCheckingOutBooking | `boolean` | não | `false` |  |
| allowPendingCheckOutBooking | `boolean` | não | `false` |  |
| allowEditProClients | `boolean` | não | `false` |  |
| allowViewProClients | `boolean` | não | `false` |  |
| allowMarkExtraServiceAsDone | `boolean` | não | `false` |  |
| allowChatWithClients | `boolean` | não | `false` |  |
| allowViewChat | `boolean` | não | `false` |  |
| allowEmitInvoice | `boolean` | não | `false` |  |
| allowSeeInvoice | `boolean` | não | `false` |  |
| allowViewBookingOccurrences | `boolean` | não | `false` |  |
| allowViewPartners | `boolean` | não | `false` |  |
| allowViewReviews | `boolean` | não | `false` |  |
| name | `text` | sim |  |  |
| allowUnlockAgent | `boolean` | não | `false` |  |
| allowViewClients | `boolean` | não | `false` |  |
| allowViewPartnerStats | `boolean` | não | `false` |  |
| allowChangeBookingStatusAfterDone | `boolean` | não | `false` |  |
| allowCreateEmailTemplate | `boolean` | não | `false` |  |
| allowCreateProClient | `boolean` | não | `false` |  |
| allowEditProClient | `boolean` | não | `false` |  |
| allowCreatePartner | `boolean` | não | `false` |  |
| allowEditPartner | `boolean` | não | `false` |  |
| allowEditAllowances | `boolean` | não | `false` |  |
| allowViewAllowances | `boolean` | não | `false` |  |
| comissionFee | `double precision` | não | `0` |  |
| notifyOnChatMessage | `boolean` | não | `false` |  |
| notifyOnOccurrenceCreated | `boolean` | não | `false` |  |
| notifyOnPriceChange | `boolean` | não | `false` |  |
| notifyOnBookingEdit | `boolean` | não | `false` |  |
| allowCreatePricingEntry | `boolean` | não | `false` |  |
| allowDeletePricingEntry | `boolean` | não | `false` |  |
| allowEditPaymentMethod | `boolean` | não | `false` |  |
| allowEditPricingPaid | `boolean` | não | `false` |  |
| allowEditPricingTotal | `boolean` | não | `false` |  |
| allowViewActivity | `boolean` | não | `false` |  |
| allowMoveBookingToPartner | `boolean` | não | `false` |  |
| allowViewFinancials | `boolean` | não | `false` |  |
| allowCreateClient | `boolean` | não | `false` |  |
| allowManagePartnerApiKeys | `boolean` | não | `false` |  |
| allowManagePartnerBilling | `boolean` | não | `false` |  |
| allowManageAllowanceBilling | `boolean` | não | `false` |  |
| allowManageProBilling | `boolean` | não | `false` |  |
| allowMoveBookingToCampaign | `boolean` | não | `false` |  |
| allowMoveBookingToAllowance | `boolean` | não | `false` |  |
| allowUseAiAgent | `boolean` | não | `false` |  |
| autoActivateAt | `timestamp(3) without time zone` | sim |  |  |
| managedByPartnerUserId | `text` | sim |  |  |
| notifyOnCancellation | `boolean` | não | `true` |  |

Chaves estrangeiras:
- parkId → Park(id)

Índices:
- `Agent_autoActivateAt_idx` ("autoActivateAt")
- `Agent_autoDeactivateAt_idx` ("autoDeactivateAt")
- `Agent_managedByPartnerUserId_idx` ("managedByPartnerUserId")
- único `Agent_userId_parkId_key` ("userId", "parkId")
- `idx_user_park` ("userId", "parkId")

## AgentInvite

Linhas (aprox.): 118 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| email | `text` | não |  |  |
| invitedBy | `text` | não |  |  |
| token | `text` | não |  |  |
| status | `"InviteStatus"` | não | `'PENDING'::"InviteStatus"` |  |
| expiresAt | `timestamp(3) without time zone` | não |  |  |
| acceptedAt | `timestamp(3) without time zone` | sim |  |  |
| acceptedBy | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| allowAgentsView | `boolean` | não | `false` |  |
| allowBulkImportBookings | `boolean` | não | `false` |  |
| allowCreateAgent | `boolean` | não | `false` |  |
| allowCreateBooking | `boolean` | não | `false` |  |
| allowEditAgent | `boolean` | não | `false` |  |
| allowEditBooking | `boolean` | não | `false` |  |
| allowEditBookingStatus | `boolean` | não | `false` |  |
| allowEditGarage | `boolean` | não | `false` |  |
| allowEditOccurrence | `boolean` | não | `false` |  |
| allowEditPark | `boolean` | não | `false` |  |
| allowEditSettings | `boolean` | não | `false` |  |
| allowExportAgentHistory | `boolean` | não | `false` |  |
| allowExportBooking | `boolean` | não | `false` |  |
| allowExportOccurrences | `boolean` | não | `false` |  |
| allowOccurrencesView | `boolean` | não | `false` |  |
| allowProcessesView | `boolean` | não | `false` |  |
| allowSettingsView | `boolean` | não | `false` |  |
| allowStatsView | `boolean` | não | `false` |  |
| parkId | `text` | não |  |  |
| allowAssignBookingSpace | `boolean` | não | `false` |  |
| allowAssignBookingSpot | `boolean` | não | `false` |  |
| allowCancelBooking | `boolean` | não | `false` |  |
| allowCheckinBooking | `boolean` | não | `false` |  |
| allowCheckoutBooking | `boolean` | não | `false` |  |
| allowCreateCampaigns | `boolean` | não | `false` |  |
| allowCreateGarage | `boolean` | não | `false` |  |
| allowCreateOccurrence | `boolean` | não | `false` |  |
| allowEditBookingPrice | `boolean` | não | `false` |  |
| allowEditCampaigns | `boolean` | não | `false` |  |
| allowMoveBooking | `boolean` | não | `false` |  |
| allowPrintBooking | `boolean` | não | `false` |  |
| allowViewAgentPage | `boolean` | não | `false` |  |
| allowViewApiKeys | `boolean` | não | `false` |  |
| allowViewBookingBooked | `boolean` | não | `false` |  |
| allowViewBookingCancelled | `boolean` | não | `false` |  |
| allowViewBookingCheckedIn | `boolean` | não | `false` |  |
| allowViewBookingCheckedOut | `boolean` | não | `false` |  |
| allowViewBookingCheckingIn | `boolean` | não | `false` |  |
| allowViewBookingCheckingOut | `boolean` | não | `false` |  |
| allowViewBookingMoving | `boolean` | não | `false` |  |
| allowViewBookingPage | `boolean` | não | `false` |  |
| allowViewCampaigns | `boolean` | não | `false` |  |
| allowViewGarages | `boolean` | não | `false` |  |
| role | `"AgentRoleType"` | não | `'JUNIOR'::"AgentRoleType"` |  |
| allowCashboxView | `boolean` | não | `false` |  |
| createdAgentId | `text` | sim |  |  |
| allowViewBookingPending | `boolean` | não | `false` |  |
| allowEditParkSettings | `boolean` | não | `false` |  |
| allowViewBookingPrice | `boolean` | não | `false` |  |
| allowViewBookingHistory | `boolean` | não | `false` |  |
| allowCreateApiKeys | `boolean` | não | `false` |  |
| allowEditApiKeys | `boolean` | não | `false` |  |
| allowEditEmail | `boolean` | não | `false` |  |
| allowEmailView | `boolean` | não | `false` |  |
| allowCashValidation | `boolean` | não | `false` |  |
| allowCloseCashier | `boolean` | não | `false` |  |
| allowDriverValidation | `boolean` | não | `false` |  |
| autoDeactivateAt | `timestamp(3) without time zone` | sim |  |  |
| allowCallClient | `boolean` | não | `false` |  |
| allowCheckingInBooking | `boolean` | não | `false` |  |
| allowCheckingOutBooking | `boolean` | não | `false` |  |
| allowPendingCheckOutBooking | `boolean` | não | `false` |  |
| allowEditProClients | `boolean` | não | `false` |  |
| allowViewProClients | `boolean` | não | `false` |  |
| allowMarkExtraServiceAsDone | `boolean` | não | `false` |  |
| allowChatWithClients | `boolean` | não | `false` |  |
| allowViewChat | `boolean` | não | `false` |  |
| allowEmitInvoice | `boolean` | não | `false` |  |
| allowSeeInvoice | `boolean` | não | `false` |  |
| allowViewBookingOccurrences | `boolean` | não | `false` |  |
| allowViewPartners | `boolean` | não | `false` |  |
| allowViewReviews | `boolean` | não | `false` |  |
| name | `text` | sim |  |  |
| allowUnlockAgent | `boolean` | não | `false` |  |
| allowViewClients | `boolean` | não | `false` |  |
| allowViewPartnerStats | `boolean` | não | `false` |  |
| autoCreatedPassword | `text` | sim |  |  |
| allowChangeBookingStatusAfterDone | `boolean` | não | `false` |  |
| allowCreateEmailTemplate | `boolean` | não | `false` |  |
| allowCreateProClient | `boolean` | não | `false` |  |
| allowEditProClient | `boolean` | não | `false` |  |
| allowCreatePartner | `boolean` | não | `false` |  |
| allowEditPartner | `boolean` | não | `false` |  |
| allowEditAllowances | `boolean` | não | `false` |  |
| allowViewAllowances | `boolean` | não | `false` |  |
| comissionFee | `double precision` | não | `0` |  |
| notifyOnBookingEdit | `boolean` | não | `false` |  |
| notifyOnChatMessage | `boolean` | não | `false` |  |
| notifyOnOccurrenceCreated | `boolean` | não | `false` |  |
| notifyOnPriceChange | `boolean` | não | `false` |  |
| allowCreatePricingEntry | `boolean` | não | `false` |  |
| allowDeletePricingEntry | `boolean` | não | `false` |  |
| allowEditPaymentMethod | `boolean` | não | `false` |  |
| allowEditPricingPaid | `boolean` | não | `false` |  |
| allowEditPricingTotal | `boolean` | não | `false` |  |
| allowViewActivity | `boolean` | não | `false` |  |
| allowMoveBookingToPartner | `boolean` | não | `false` |  |
| allowViewFinancials | `boolean` | não | `false` |  |
| allowCreateClient | `boolean` | não | `false` |  |
| allowManagePartnerApiKeys | `boolean` | não | `false` |  |
| allowManagePartnerBilling | `boolean` | não | `false` |  |
| allowManageAllowanceBilling | `boolean` | não | `false` |  |
| allowManageProBilling | `boolean` | não | `false` |  |
| allowMoveBookingToCampaign | `boolean` | não | `false` |  |
| allowMoveBookingToAllowance | `boolean` | não | `false` |  |
| allowUseAiAgent | `boolean` | não | `false` |  |
| autoActivateAt | `timestamp(3) without time zone` | sim |  |  |
| managedByPartnerUserId | `text` | sim |  |  |
| notifyOnCancellation | `boolean` | não | `true` |  |

Chaves estrangeiras:
- createdAgentId → Agent(id)
- parkId → Park(id)

Índices:
- `AgentInvite_autoActivateAt_idx` ("autoActivateAt")
- `AgentInvite_autoDeactivateAt_idx` ("autoDeactivateAt")
- único `AgentInvite_createdAgentId_key` ("createdAgentId")
- `AgentInvite_email_idx` (email)
- `AgentInvite_expiresAt_idx` ("expiresAt")
- `AgentInvite_managedByPartnerUserId_idx` ("managedByPartnerUserId")
- `AgentInvite_parkId_idx` ("parkId")
- `AgentInvite_status_idx` (status)

## AggregatorProcessedEvent

Linhas (aprox.): 51 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| source | `"AggregatorSource"` | não |  |  |
| operatorId | `text` | não |  |  |
| eventId | `text` | não |  |  |
| eventType | `text` | não |  |  |
| bookingReference | `text` | não |  |  |
| bookingId | `text` | sim |  |  |
| processedAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |

Índices:
- único `AggregatorProcessedEvent_source_operatorId_eventId_key` (source, "operatorId", "eventId")
- `AggregatorProcessedEvent_source_operatorId_processedAt_idx` (source, "operatorId", "processedAt")

## AggregatorQuarantineItem

Linhas (aprox.): 9 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| source | `"AggregatorSource"` | não |  |  |
| operatorId | `text` | não |  |  |
| eventId | `text` | não |  |  |
| eventType | `text` | sim |  |  |
| bookingReference | `text` | sim |  |  |
| reason | `"AggregatorQuarantineReason"` | não |  |  |
| message | `text` | não |  |  |
| payload | `jsonb` | sim |  |  |
| status | `"AggregatorQuarantineStatus"` | não | `'PENDING'::"AggregatorQuarantineStatus"` |  |
| attempts | `integer` | não | `0` |  |
| lastAttemptAt | `timestamp(3) without time zone` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Índices:
- único `AggregatorQuarantineItem_source_operatorId_eventId_key` (source, "operatorId", "eventId")
- `AggregatorQuarantineItem_status_source_idx` (status, source)

## AiConversation

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| userId | `text` | não |  |  |
| profile | `"AiChatProfile"` | não | `'GERAL'::"AiChatProfile"` |  |
| parkIds | `text[]` | sim |  |  |
| title | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Índices:
- `AiConversation_userId_updatedAt_idx` ("userId", "updatedAt")

## AiEmailMessage

Linhas (aprox.): 2792 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| gmailMessageId | `text` | não |  |  |
| gmailThreadId | `text` | não |  |  |
| rfcMessageId | `text` | sim |  |  |
| fromEmail | `text` | não |  |  |
| fromName | `text` | sim |  |  |
| toEmail | `text` | sim |  |  |
| subject | `text` | sim |  |  |
| bodyText | `text` | não |  |  |
| snippet | `text` | sim |  |  |
| attachments | `jsonb` | sim |  |  |
| receivedAt | `timestamp(3) without time zone` | não |  |  |
| summary | `text` | sim |  |  |
| category | `"AiEmailCategory"` | sim |  |  |
| draftReply | `text` | sim |  |  |
| draftUpdatedAt | `timestamp(3) without time zone` | sim |  |  |
| draftUpdatedBy | `text` | sim |  |  |
| aiModel | `text` | sim |  |  |
| aiError | `text` | sim |  |  |
| status | `"AiEmailStatus"` | não | `'PENDENTE'::"AiEmailStatus"` |  |
| clientId | `text` | sim |  |  |
| partnerId | `text` | sim |  |  |
| linkedManually | `boolean` | não | `false` |  |
| assignedByUserId | `text` | sim |  |  |
| sentAt | `timestamp(3) without time zone` | sim |  |  |
| sentByUserId | `text` | sim |  |  |
| sentMessageId | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Chaves estrangeiras:
- clientId → Client(id)
- partnerId → Partner(id)

Índices:
- `AiEmailMessage_category_receivedAt_idx` (category, "receivedAt")
- `AiEmailMessage_clientId_idx` ("clientId")
- `AiEmailMessage_fromEmail_idx` ("fromEmail")
- único `AiEmailMessage_gmailMessageId_key` ("gmailMessageId")
- `AiEmailMessage_partnerId_idx` ("partnerId")
- `AiEmailMessage_receivedAt_idx` ("receivedAt")
- `AiEmailMessage_status_receivedAt_idx` (status, "receivedAt")

## AiEmailSyncState

Linhas (aprox.): 1 · PK: mailbox

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| mailbox | `text` | não |  |  |
| historyId | `text` | sim |  |  |
| lastSyncAt | `timestamp(3) without time zone` | sim |  |  |
| lastError | `text` | sim |  |  |
| lastSyncCount | `integer` | não | `0` |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

## AiMessage

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| conversationId | `text` | não |  |  |
| role | `"AiMessageRole"` | não |  |  |
| content | `text` | não |  |  |
| toolCalls | `jsonb` | sim |  |  |
| model | `text` | sim |  |  |
| inputTokens | `integer` | sim |  |  |
| outputTokens | `integer` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |

Chaves estrangeiras:
- conversationId → AiConversation(id)

Índices:
- `AiMessage_conversationId_createdAt_idx` ("conversationId", "createdAt")

## Allocation

Linhas (aprox.): 38 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| name | `text` | não |  |  |
| minAllocation | `integer` | não |  |  |
| maxAllocation | `integer` | não |  |  |
| parkingType | `"ParkingType"` | não |  |  |
| prefix | `text` | sim |  |  |
| parkId | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Chaves estrangeiras:
- parkId → Park(id)

Índices:
- `Allocation_parkId_idx` ("parkId")
- único `Allocation_parkId_name_key` ("parkId", name)

## Allowance

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| name | `text` | não |  |  |
| type | `"AllowanceType"` | não | `'PUBLIC'::"AllowanceType"` |  |
| status | `"AllowanceStatus"` | não | `'ACTIVE'::"AllowanceStatus"` |  |
| validFrom | `timestamp(3) without time zone` | não |  |  |
| validTo | `timestamp(3) without time zone` | não |  |  |
| ownerClientId | `text` | sim |  |  |
| ownerEmail | `text` | sim |  |  |
| parkId | `text` | não |  |  |
| parkIds | `text[]` | sim | `ARRAY[]::text[]` |  |
| cadence | `"AllowanceCadence"` | não |  |  |
| parkingType | `"ParkingType"` | não |  |  |
| vehicleType | `"VehicleSize"` | não | `'CAR'::"VehicleSize"` |  |
| price | `double precision` | não |  |  |
| maxBookings | `integer` | sim |  |  |
| description | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| discountTiers | `jsonb` | sim |  |  |

Chaves estrangeiras:
- ownerClientId → Client(id)
- parkId → Park(id)

Índices:
- `Allowance_ownerEmail_idx` ("ownerEmail")
- `Allowance_parkId_idx` ("parkId")
- `Allowance_parkId_status_idx` ("parkId", status)
- `Allowance_status_validFrom_validTo_idx` (status, "validFrom", "validTo")
- `Allowance_type_status_idx` (type, status)

## ApiKey

Linhas (aprox.): 38 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| parkId | `text` | não |  |  |
| name | `text` | não |  |  |
| keyHash | `text` | não |  |  |
| keyPrefix | `text` | não |  |  |
| status | `"ApiKeyStatus"` | não | `'ACTIVE'::"ApiKeyStatus"` |  |
| rateLimit | `integer` | sim |  |  |
| ipWhitelist | `text[]` | sim |  |  |
| expiresAt | `timestamp(3) without time zone` | sim |  |  |
| lastUsedAt | `timestamp(3) without time zone` | sim |  |  |
| lastUsedIp | `text` | sim |  |  |
| requestCount | `integer` | não | `0` |  |
| description | `text` | sim |  |  |
| createdBy | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| revokedAt | `timestamp(3) without time zone` | sim |  |  |
| revokedBy | `text` | sim |  |  |
| partnerId | `text` | sim |  |  |

Chaves estrangeiras:
- parkId → Park(id)
- partnerId → Partner(id)

Índices:
- `ApiKey_expiresAt_idx` ("expiresAt")
- `ApiKey_keyHash_idx` ("keyHash")
- único `ApiKey_keyHash_key` ("keyHash")
- `ApiKey_parkId_idx` ("parkId")
- `ApiKey_partnerId_idx` ("partnerId")
- `ApiKey_status_idx` (status)

## ArticleComment

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| articleSource | `"ArticleSource"` | não |  |  |
| articleSlug | `text` | não |  |  |
| articleId | `text` | sim |  |  |
| userId | `text` | não |  |  |
| userName | `text` | não |  |  |
| userRole | `"ArticleAuthorType"` | não |  |  |
| content | `text` | não |  |  |
| parentId | `text` | sim |  |  |
| status | `"CommentStatus"` | não | `'VISIBLE'::"CommentStatus"` |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Chaves estrangeiras:
- parentId → ArticleComment(id)

Índices:
- `ArticleComment_articleSource_articleSlug_status_createdAt_idx` ("articleSource", "articleSlug", status, "createdAt")
- `ArticleComment_userId_idx` ("userId")

## ArticleFavourite

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| articleSource | `"ArticleSource"` | não |  |  |
| articleSlug | `text` | não |  |  |
| articleId | `text` | sim |  |  |
| userId | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |

Índices:
- único `ArticleFavourite_articleSource_articleSlug_userId_key` ("articleSource", "articleSlug", "userId")
- `ArticleFavourite_userId_createdAt_idx` ("userId", "createdAt")

## ArticleReview

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| articleSource | `"ArticleSource"` | não |  |  |
| articleSlug | `text` | não |  |  |
| articleId | `text` | sim |  |  |
| userId | `text` | não |  |  |
| rating | `integer` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Índices:
- `ArticleReview_articleSource_articleSlug_idx` ("articleSource", "articleSlug")
- único `ArticleReview_articleSource_articleSlug_userId_key` ("articleSource", "articleSlug", "userId")

## Attachment

Linhas (aprox.): 1497 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| type | `"AttachmentType"` | não |  |  |
| url | `text` | não |  |  |
| bookingId | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Chaves estrangeiras:
- bookingId → Booking(id)

Índices:
- `Attachment_bookingId_idx` ("bookingId")

## Billing

Linhas (aprox.): 8652 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| userId | `text` | não |  |  |
| provider | `text` | não |  |  |
| paymentIntentId | `text` | sim |  |  |
| amount | `double precision` | não |  |  |
| currency | `text` | não | `'EUR'::text` |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| bookingId | `text` | sim |  |  |
| description | `text` | não |  |  |
| invoice | `text` | sim |  |  |
| invoiceExpressId | `integer` | sim |  |  |
| invoiceExpressType | `text` | sim |  |  |
| emited | `boolean` | não | `false` |  |
| parkId | `text` | sim |  |  |
| parkIds | `text[]` | sim | `ARRAY[]::text[]` |  |
| periodKeys | `text[]` | não | `ARRAY[]::text[]` |  |

Chaves estrangeiras:
- bookingId → Booking(id)

Índices:
- `Billing_bookingId_idx` ("bookingId")
- `Billing_createdAt_idx` ("createdAt")
- único `Billing_invoice_key` (invoice)
- `Billing_parkId_idx` ("parkId")
- `Billing_paymentIntentId_idx` ("paymentIntentId")
- `Billing_userId_idx` ("userId")

## Booking

Linhas (aprox.): 67 747 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| checkInDate | `timestamp(3) without time zone` | não |  |  |
| checkOutDate | `timestamp(3) without time zone` | não |  |  |
| checkInTime | `text` | não |  |  |
| checkOutTime | `text` | não |  |  |
| bookingPrice | `double precision` | não |  |  |
| pricingType | `"PricingType"` | não |  |  |
| parkingType | `"ParkingType"` | não |  |  |
| parkingPrice | `double precision` | não |  |  |
| deliveryType | `text` | não |  |  |
| deliveryPrice | `double precision` | não |  |  |
| status | `"BookingStatus"` | não | `'PENDING'::"BookingStatus"` |  |
| deliveryLocation | `text` | sim |  |  |
| returnFlight | `text` | sim |  |  |
| departingFlight | `text` | sim |  |  |
| paymentIntentId | `text` | sim |  |  |
| parkId | `text` | não |  |  |
| spotId | `text` | sim |  |  |
| partnerId | `text` | sim |  |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| vehicleId | `text` | sim |  |  |
| checkinVideo | `text` | sim |  |  |
| language | `text` | sim |  |  |
| remarks | `text` | sim |  |  |
| taxName | `text` | sim |  |  |
| taxNumber | `text` | sim |  |  |
| checkIn | `timestamp(3) without time zone` | não |  |  |
| checkOut | `timestamp(3) without time zone` | não |  |  |
| requestEvaluation | `boolean` | não | `false` |  |
| garageId | `text` | sim |  |  |
| paymentMethod | `text` | sim | `''::text` |  |
| campaignId | `text` | sim |  |  |
| creditId | `text` | sim |  |  |
| customerId | `text` | sim |  |  |
| clientId | `text` | não |  |  |
| splitTransactionId | `text` | sim |  |  |
| paymentBy | `text` | sim | `''::text` |  |
| allocation | `text` | sim |  |  |
| allocationId | `text` | sim |  |  |
| odooId | `integer` | sim |  |  |
| firebaseId | `text` | sim |  |  |
| priceValidated | `boolean` | não | `false` |  |
| vehicleKms | `text` | sim |  |  |
| vehicleRange | `text` | sim |  |  |
| checkinSignature | `text` | sim |  | Client signature at check-in (base64 encoded string or URL) |
| checkoutSignature | `text` | sim |  | Client signature at check-out (base64 encoded string or URL) |
| checkInDriverId | `text` | sim |  | User ID of the agent who performed check-in |
| checkInDriverName | `text` | sim |  | Full name of the agent who performed check-in |
| checkOutDriverId | `text` | sim |  | User ID of the agent who performed check-out |
| checkOutDriverName | `text` | sim |  | Full name of the agent who performed check-out |
| cashValidated | `boolean` | não | `false` |  |
| cashValidatedAt | `timestamp(3) without time zone` | sim |  |  |
| cashValidatedById | `text` | sim |  |  |
| cashValidatedByName | `text` | sim |  |  |
| cashierClosed | `boolean` | não | `false` |  |
| cashierClosedAt | `timestamp(3) without time zone` | sim |  |  |
| cashierClosedById | `text` | sim |  |  |
| cashierClosedByName | `text` | sim |  |  |
| driverValidated | `boolean` | não | `false` |  |
| driverValidatedAt | `timestamp(3) without time zone` | sim |  |  |
| driverValidatedById | `text` | sim |  |  |
| driverValidatedByName | `text` | sim |  |  |
| externalGarage | `text` | sim |  |  |
| externalRow | `text` | sim |  |  |
| externalSpot | `text` | sim |  |  |
| checkingInAt | `timestamp(3) without time zone` | sim |  |  |
| pendingCheckoutAt | `timestamp(3) without time zone` | sim |  |  |
| checkingOutAt | `timestamp(3) without time zone` | sim |  |  |
| movingAt | `timestamp(3) without time zone` | sim |  |  |
| arrivedAtDeliveryAt | `timestamp(3) without time zone` | sim |  |  |
| baggageWaitingAt | `timestamp(3) without time zone` | sim |  |  |
| customerCheckinEta | `integer` | sim |  |  |
| createdBy | `text` | sim |  |  |
| externalCampaign | `text` | sim |  |  |
| pro | `boolean` | sim | `false` |  |
| discountAmount | `double precision` | sim |  |  |
| discountApplied | `double precision` | sim |  |  |
| proClientId | `text` | sim |  |  |
| taxAddress | `text` | sim |  |  |
| bookingFeeId | `text` | sim |  |  |
| partnerFeeType | `"PartnerFeeType"` | sim |  |  |
| partnerFeeValue | `double precision` | sim |  |  |
| partnerAmountDue | `double precision` | sim |  |  |
| partnerAmountPaid | `double precision` | sim |  |  |
| partnerContributedAmount | `double precision` | sim |  |  |
| departingFlightEta | `timestamp(3) without time zone` | sim |  |  |
| returnFlightEta | `timestamp(3) without time zone` | sim |  |  |
| paymentReminderSentAt | `timestamp(3) without time zone` | sim |  |  |
| originalBookingPrice | `double precision` | não | `0` |  |
| origin | `"BookingOrigin"` | não | `'API'::"BookingOrigin"` |  |
| originUrl | `text` | sim |  |  |
| externalReference | `text` | sim |  |  |
| paymentSource | `"PaymentSource"` | sim |  |  |
| currency | `text` | não | `'EUR'::text` |  |
| idempotencyKey | `text` | sim |  |  |
| commissionAmount | `double precision` | sim |  |  |
| disputeEvents | `jsonb` | sim |  |  |
| stripeChargeId | `text` | sim |  |  |
| clientPlanId | `text` | sim |  |  |
| allowance | `boolean` | sim | `false` |  |
| checkoutReminderSentAt | `timestamp(3) without time zone` | sim |  |  |
| firebaseSyncedAt | `timestamp(3) without time zone` | sim |  |  |
| firebaseSyncError | `text` | sim |  |  |
| onlinePaymentRequestedAt | `timestamp(3) without time zone` | sim |  |  |

Chaves estrangeiras:
- allocationId → Allocation(id)
- bookingFeeId → BookingFee(id)
- clientPlanId → ClientPlan(id)
- creditId → Credit(id)
- customerId → Client(id)
- garageId → Garage(id)
- parkId → Park(id)
- partnerId → Partner(id)
- proClientId → ProClient(id)
- spotId → Spot(id)
- vehicleId → BookingVehicle(id)

Índices:
- único `Booking_bookingFeeId_key` ("bookingFeeId")
- `Booking_createdBy_idx` ("createdBy")
- único `Booking_creditId_key` ("creditId")
- `Booking_customerId_idx` ("customerId")
- `Booking_parkId_allocation_status_idx` ("parkId", allocation, status)
- `Booking_parkId_checkInDate_idx` ("parkId", "checkInDate")
- `Booking_parkId_checkOutDate_idx` ("parkId", "checkOutDate")
- `Booking_parkId_createdAt_idx` ("parkId", "createdAt")
- único `Booking_parkId_externalReference_partial_key` ("parkId", "externalReference")
- único `Booking_parkId_idempotencyKey_key` ("parkId", "idempotencyKey")
- `Booking_parkId_onlinePaymentRequestedAt_idx` ("parkId", "onlinePaymentRequestedAt")
- `Booking_parkId_status_checkInDate_idx` ("parkId", status, "checkInDate")
- `Booking_parkId_status_checkOutDate_idx` ("parkId", status, "checkOutDate")
- `Booking_parkId_status_idx` ("parkId", status)
- `Booking_parkId_updatedAt_idx` ("parkId", "updatedAt")
- `Booking_status_idx` (status)

## BookingDraft

Linhas (aprox.): 745 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| draftId | `text` | não |  |  |
| paymentIntentId | `text` | sim |  |  |
| parkId | `text` | não |  |  |
| payload | `jsonb` | não |  |  |
| amountCents | `integer` | não |  |  |
| status | `"BookingDraftStatus"` | não | `'PENDING'::"BookingDraftStatus"` |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Índices:
- único `BookingDraft_draftId_key` ("draftId")
- `BookingDraft_paymentIntentId_idx` ("paymentIntentId")
- `BookingDraft_status_createdAt_idx` (status, "createdAt")

## BookingExtraService

Linhas (aprox.): 23 486 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| name | `text` | não |  |  |
| description | `text` | sim |  |  |
| price | `double precision` | não |  |  |
| done | `boolean` | não | `false` |  |
| bookingId | `text` | não |  |  |
| vehicleType | `"VehicleSize"` | sim | `'CAR'::"VehicleSize"` |  |

Chaves estrangeiras:
- bookingId → Booking(id)

## BookingFee

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| description | `text` | não |  |  |
| value | `double precision` | não | `0` |  |
| bookingId | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Índices:
- único `BookingFee_bookingId_key` ("bookingId")

## BookingPaymentLink

Linhas (aprox.): 86 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| bookingId | `text` | não |  |  |
| paymentIntentId | `text` | não |  |  |
| amountCents | `integer` | não |  |  |
| currency | `text` | não | `'eur'::text` |  |
| status | `"BookingPaymentLinkStatus"` | não | `'PENDING'::"BookingPaymentLinkStatus"` |  |
| paymentMethodType | `text` | sim |  |  |
| paymentMethodLabel | `text` | sim |  |  |
| amountReceivedCents | `integer` | sim |  |  |
| stripeChargeId | `text` | sim |  |  |
| splitTransactionId | `text` | sim |  |  |
| applicationFeeAmount | `double precision` | sim |  |  |
| settledAt | `timestamp(3) without time zone` | sim |  |  |
| lastError | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Chaves estrangeiras:
- bookingId → Booking(id)

Índices:
- `BookingPaymentLink_bookingId_idx` ("bookingId")
- único `BookingPaymentLink_paymentIntentId_key` ("paymentIntentId")
- `BookingPaymentLink_status_createdAt_idx` (status, "createdAt")

## BookingPricing

Linhas (aprox.): 92 791 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| paymentMethod | `text` | sim |  |  |
| bookingId | `text` | não |  |  |
| amountPaid | `double precision` | não | `0` |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| description | `text` | não |  |  |
| total | `double precision` | não |  |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| category | `"PricingEntryCategory"` | sim |  |  |
| extraServiceId | `text` | sim |  |  |

Chaves estrangeiras:
- bookingId → Booking(id)

Índices:
- `BookingPricing_bookingId_idx` ("bookingId")

## BookingPricingPayment

Linhas (aprox.): 39 693 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| pricingId | `text` | não |  |  |
| amount | `double precision` | não |  |  |
| paymentMethod | `text` | não |  |  |
| recordedAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |

Chaves estrangeiras:
- pricingId → BookingPricing(id)

Índices:
- `BookingPricingPayment_pricingId_idx` ("pricingId")

## BookingReview

Linhas (aprox.): 205 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| bookingId | `text` | não |  |  |
| parkId | `text` | não |  |  |
| clientId | `text` | não |  |  |
| clientName | `text` | não |  |  |
| rating | `integer` | não |  |  |
| comment | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Chaves estrangeiras:
- bookingId → Booking(id)
- parkId → Park(id)

Índices:
- único `BookingReview_bookingId_key` ("bookingId")
- `BookingReview_clientId_idx` ("clientId")
- `BookingReview_parkId_createdAt_idx` ("parkId", "createdAt")
- `BookingReview_parkId_rating_idx` ("parkId", rating)

## BookingVehicle

Linhas (aprox.): 65 213 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| licensePlate | `text` | não |  |  |
| brand | `text` | não |  |  |
| model | `text` | não |  |  |
| color | `text` | não |  |  |
| vehicleType | `"VehicleSize"` | não | `'CAR'::"VehicleSize"` |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| seats | `integer` | sim | `5` |  |

Índices:
- `BookingVehicle_licensePlate_idx` ("licensePlate")

## Campaign

Linhas (aprox.): 41 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| parkId | `text` | não |  |  |
| name | `text` | não |  |  |
| description | `text` | sim |  |  |
| status | `"CampaignStatus"` | não | `'DRAFT'::"CampaignStatus"` |  |
| accessType | `"CampaignAccessType"` | não | `'PUBLIC'::"CampaignAccessType"` |  |
| startDate | `timestamp(3) without time zone` | sim |  |  |
| endDate | `timestamp(3) without time zone` | sim |  |  |
| createdBy | `text` | sim |  |  |
| bookingCount | `integer` | não | `0` |  |
| revenue | `double precision` | não | `0` |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| discountType | `"DiscountType"` | sim |  |  |
| discountValue | `double precision` | sim |  |  |
| currentUses | `integer` | não | `0` |  |
| maxUses | `integer` | sim |  |  |
| minimumAmount | `double precision` | sim |  |  |
| discountCode | `text` | sim |  |  |

Chaves estrangeiras:
- parkId → Park(id)

Índices:
- único `Campaign_discountCode_key` ("discountCode")
- `Campaign_parkId_status_idx` ("parkId", status)
- `Campaign_startDate_endDate_idx` ("startDate", "endDate")
- `Campaign_status_idx` (status)

## CampaignDeliveryType

Linhas (aprox.): 118 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| campaignId | `text` | não |  |  |
| name | `text` | não |  |  |
| price | `double precision` | não |  |  |
| address | `text` | sim |  |  |
| sortOrder | `integer` | não | `0` |  |
| callBeforeMinutes | `integer` | não | `15` |  |
| checkoutAt | `text` | sim |  |  |
| checkoutLocation | `text` | sim |  |  |

Chaves estrangeiras:
- campaignId → Campaign(id)

## CampaignExtraFee

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| campaignId | `text` | não |  |  |
| name | `"FeeType"` | não |  |  |
| price | `double precision` | não |  |  |

Chaves estrangeiras:
- campaignId → Campaign(id)

Índices:
- único `CampaignExtraFee_campaignId_name_key` ("campaignId", name)

## CampaignExtraService

Linhas (aprox.): 339 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| campaignId | `text` | não |  |  |
| name | `text` | não |  |  |
| price | `double precision` | não |  |  |
| sortOrder | `integer` | não | `0` |  |

Chaves estrangeiras:
- campaignId → Campaign(id)

## CampaignPricing

Linhas (aprox.): 123 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| campaignId | `text` | não |  |  |
| pricingType | `"PricingType"` | não |  |  |
| parkingType | `"ParkingType"` | não |  |  |
| vehicleType | `"VehicleSize"` | não |  |  |
| price | `double precision` | não |  |  |

Chaves estrangeiras:
- campaignId → Campaign(id)

Índices:
- único `CampaignPricing_campaignId_pricingType_parkingType_vehicleT_key` ("campaignId", "pricingType", "parkingType", "vehicleType")

## Cancellation

Linhas (aprox.): 1091 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| cancellationType | `text` | não |  |  |
| cancellationObs | `text` | não |  |  |
| refund | `boolean` | não | `false` |  |
| refunded | `boolean` | não | `false` |  |
| bookingId | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| refundTransactionId | `text` | sim |  |  |
| refundedAt | `timestamp(3) without time zone` | sim |  |  |
| refundedAmount | `double precision` | não | `0` |  |

Chaves estrangeiras:
- bookingId → Booking(id)

Índices:
- único `Cancellation_bookingId_key` ("bookingId")
- `Cancellation_createdAt_idx` ("createdAt")

## ChatMessage

Linhas (aprox.): 2210 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| bookingId | `text` | não |  |  |
| senderId | `text` | não |  |  |
| senderName | `text` | não |  |  |
| senderRole | `"ChatSenderRole"` | não |  |  |
| content | `text` | não |  |  |
| readByPark | `boolean` | não | `false` |  |
| readByClient | `boolean` | não | `false` |  |
| readAt | `timestamp(3) without time zone` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| attachmentId | `text` | sim |  |  |
| hasAttachment | `boolean` | não | `false` |  |

Chaves estrangeiras:
- attachmentId → Attachment(id)
- bookingId → Booking(id)

Índices:
- `ChatMessage_attachmentId_idx` ("attachmentId")
- `ChatMessage_bookingId_createdAt_idx` ("bookingId", "createdAt")
- `ChatMessage_bookingId_readByClient_idx` ("bookingId", "readByClient")
- `ChatMessage_bookingId_readByPark_idx` ("bookingId", "readByPark")

## Client

Linhas (aprox.): 45 935 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| firstName | `text` | não |  |  |
| lastName | `text` | não |  |  |
| email | `text` | não |  |  |
| phoneNumber | `text` | não |  |  |
| nif | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| iban | `text` | sim |  |  |
| taxName | `text` | sim |  |  |
| mitTransactionId | `text` | sim |  |  |
| mitPaymentMethod | `text` | sim |  |  |
| mitEnabledAt | `timestamp(3) without time zone` | sim |  |  |
| autoBillingEnabled | `boolean` | não | `false` |  |
| anonymizedAt | `timestamp(3) without time zone` | sim |  |  |

Índices:
- `Client_anonymizedAt_idx` ("anonymizedAt")

## ClientPlan

Linhas (aprox.): 14 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| clientId | `text` | não |  |  |
| allowanceId | `text` | não |  |  |
| parkId | `text` | não |  |  |
| parkIds | `text[]` | sim | `ARRAY[]::text[]` |  |
| status | `"ClientPlanStatus"` | não | `'PENDING'::"ClientPlanStatus"` |  |
| pricePerPeriod | `double precision` | não |  |  |
| cadence | `"AllowanceCadence"` | não |  |  |
| maxBookings | `integer` | sim |  |  |
| endDate | `timestamp(3) without time zone` | não |  |  |
| snapshotTakenAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| currentPeriodStart | `timestamp(3) without time zone` | não |  |  |
| currentPeriodEnd | `timestamp(3) without time zone` | não |  |  |
| nextBillingDate | `timestamp(3) without time zone` | sim |  |  |
| lastPaymentDate | `timestamp(3) without time zone` | sim |  |  |
| lastPaymentAmount | `double precision` | sim |  |  |
| mitTransactionId | `text` | sim |  |  |
| mitPaymentMethod | `text` | sim |  |  |
| mitEnabledAt | `timestamp(3) without time zone` | sim |  |  |
| mitRetryCount | `integer` | não | `0` |  |
| mitLastRetryAt | `timestamp(3) without time zone` | sim |  |  |
| autoRenewalEnabled | `boolean` | não | `true` |  |
| cancelAtPeriodEnd | `boolean` | não | `false` |  |
| assignedByAgentId | `text` | sim |  |  |
| assignedAt | `timestamp(3) without time zone` | sim |  |  |
| pendingEmail | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| language | `text` | sim |  |  |
| loginToken | `text` | sim |  |  |
| loginTokenExpiresAt | `timestamp(3) without time zone` | sim |  |  |
| periodEndReminderSentAt | `timestamp(3) without time zone` | sim |  |  |
| discountTiers | `jsonb` | sim |  |  |
| startsAt | `timestamp(3) without time zone` | sim |  |  |

Chaves estrangeiras:
- allowanceId → Allowance(id)
- clientId → Client(id)
- parkId → Park(id)

Índices:
- `ClientPlan_allowanceId_status_idx` ("allowanceId", status)
- `ClientPlan_clientId_idx` ("clientId")
- único `ClientPlan_loginToken_key` ("loginToken")
- `ClientPlan_nextBillingDate_idx` ("nextBillingDate")
- único `ClientPlan_one_open_per_allowance` ("clientId", "allowanceId")
- `ClientPlan_parkId_idx` ("parkId")
- `ClientPlan_pendingEmail_idx` ("pendingEmail")
- `ClientPlan_status_idx` (status)

## ClientPlanAttachment

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| type | `"AttachmentType"` | não |  |  |
| url | `text` | não |  |  |
| clientPlanId | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Chaves estrangeiras:
- clientPlanId → ClientPlan(id)

Índices:
- `ClientPlanAttachment_clientPlanId_idx` ("clientPlanId")

## ClientPlanPayment

Linhas (aprox.): 63 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| clientPlanId | `text` | não |  |  |
| transactionId | `text` | não |  |  |
| amount | `double precision` | não |  |  |
| planAmount | `double precision` | não | `0` |  |
| extrasAmount | `double precision` | não | `0` |  |
| bookingIds | `text[]` | sim | `ARRAY[]::text[]` |  |
| currency | `text` | não | `'EUR'::text` |  |
| status | `"PaymentStatus"` | não | `'PENDING'::"PaymentStatus"` |  |
| paymentMethod | `text` | sim |  |  |
| billingPeriodStart | `timestamp(3) without time zone` | não |  |  |
| billingPeriodEnd | `timestamp(3) without time zone` | não |  |  |
| isMitCharge | `boolean` | não | `false` |  |
| failureReason | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| parkId | `text` | sim |  |  |
| submerchantId | `text` | sim |  |  |
| splitProvider | `text` | sim |  |  |
| splitGrossAmount | `double precision` | sim |  |  |
| commissionPercentage | `double precision` | sim |  |  |
| commissionAmount | `double precision` | sim |  |  |
| splitStatus | `"PlatformSplitStatus"` | sim |  |  |
| splitTransactionId | `text` | sim |  |  |
| stripeChargeId | `text` | sim |  |  |
| splitFailedReason | `text` | sim |  |  |
| splitSettledAt | `timestamp(3) without time zone` | sim |  |  |

Chaves estrangeiras:
- clientPlanId → ClientPlan(id)

Índices:
- `ClientPlanPayment_clientPlanId_idx` ("clientPlanId")
- `ClientPlanPayment_parkId_splitSettledAt_idx` ("parkId", "splitSettledAt")
- `ClientPlanPayment_status_idx` (status)
- `ClientPlanPayment_transactionId_idx` ("transactionId")
- único `ClientPlanPayment_transactionId_key` ("transactionId")

## ClientPlanPendingPeriod

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| clientPlanId | `text` | não |  |  |
| periodStart | `timestamp(3) without time zone` | não |  |  |
| periodEnd | `timestamp(3) without time zone` | não |  |  |
| markedAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| markedByUserId | `text` | sim |  |  |
| markedByName | `text` | sim |  |  |
| note | `text` | sim |  |  |
| notifiedAt7 | `timestamp(3) without time zone` | sim |  |  |
| notifiedAt14 | `timestamp(3) without time zone` | sim |  |  |
| resolvedAt | `timestamp(3) without time zone` | sim |  |  |
| resolvedReason | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Chaves estrangeiras:
- clientPlanId → ClientPlan(id)

Índices:
- `ClientPlanPendingPeriod_clientPlanId_idx` ("clientPlanId")
- único `ClientPlanPendingPeriod_clientPlanId_periodStart_key` ("clientPlanId", "periodStart")
- `ClientPlanPendingPeriod_markedAt_idx` ("markedAt")
- `ClientPlanPendingPeriod_resolvedAt_idx` ("resolvedAt")

## CommunityArticle

Linhas (aprox.): 2 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| slug | `text` | não |  |  |
| title | `text` | não |  |  |
| subtitle | `text` | sim |  |  |
| category | `text` | não |  |  |
| banner | `text` | sim |  |  |
| contentMd | `text` | não |  |  |
| contentHtml | `text` | não |  |  |
| tags | `text[]` | sim | `ARRAY[]::text[]` |  |
| readTimeMin | `integer` | sim |  |  |
| authorId | `text` | não |  |  |
| authorType | `"ArticleAuthorType"` | não |  |  |
| authorName | `text` | não |  |  |
| visibility | `"ArticleVisibility"` | não | `'DRAFT'::"ArticleVisibility"` |  |
| publishedAt | `timestamp(3) without time zone` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| commentCount | `integer` | não | `0` |  |
| reviewCount | `integer` | não | `0` |  |
| ratingSum | `integer` | não | `0` |  |
| favouriteCount | `integer` | não | `0` |  |
| featured | `boolean` | não | `false` |  |
| locale | `"ArticleLocale"` | não | `'pt-PT'::"ArticleLocale"` |  |

Índices:
- `CommunityArticle_authorId_authorType_idx` ("authorId", "authorType")
- `CommunityArticle_category_visibility_idx` (category, visibility)
- `CommunityArticle_featured_visibility_publishedAt_idx` (featured, visibility, "publishedAt")
- `CommunityArticle_locale_visibility_publishedAt_idx` (locale, visibility, "publishedAt")
- único `CommunityArticle_slug_key` (slug)
- `CommunityArticle_visibility_publishedAt_idx` (visibility, "publishedAt")
- `community_article_search_idx` (to_tsvector('simple'::regconfig, (COALESCE(title, ''::text) \|\| ' '::text) \|\| COALESCE(subtitle, ''::text)))

## ConnectionDelivery

Linhas (aprox.): 8260 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| endpointId | `text` | não |  |  |
| eventType | `"ConnectionEventType"` | não |  |  |
| bookingId | `text` | sim |  |  |
| payload | `jsonb` | não |  |  |
| status | `"ConnectionDeliveryStatus"` | não | `'PENDING'::"ConnectionDeliveryStatus"` |  |
| attempts | `integer` | não | `0` |  |
| maxAttempts | `integer` | não | `6` |  |
| nextAttemptAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| lastError | `text` | sim |  |  |
| responseCode | `integer` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Chaves estrangeiras:
- endpointId → ConnectionEndpoint(id)

Índices:
- `ConnectionDelivery_bookingId_eventType_idx` ("bookingId", "eventType")
- `ConnectionDelivery_endpointId_idx` ("endpointId")
- `ConnectionDelivery_status_nextAttemptAt_idx` (status, "nextAttemptAt")

## ConnectionEndpoint

Linhas (aprox.): 51 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| parkId | `text` | não |  |  |
| eventType | `"ConnectionEventType"` | sim |  |  |
| name | `text` | não |  |  |
| url | `text` | sim |  |  |
| secretEnc | `text` | sim |  |  |
| secretLast4 | `text` | sim |  |  |
| enabled | `boolean` | não | `true` |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| provider | `"ConnectionProvider"` | não | `'GENERIC_WEBHOOK'::"ConnectionProvider"` |  |
| direction | `"ConnectionDirection"` | não | `'OUTBOUND_PUSH'::"ConnectionDirection"` |  |
| config | `jsonb` | sim |  |  |

Chaves estrangeiras:
- parkId → Park(id)

Índices:
- único `ConnectionEndpoint_parkId_eventType_key` ("parkId", "eventType")
- `ConnectionEndpoint_parkId_idx` ("parkId")
- único `ConnectionEndpoint_parkId_provider_config_key` ("parkId", provider)
- `ConnectionEndpoint_parkId_provider_idx` ("parkId", provider)

## ConnectionExternalRef

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| endpointId | `text` | não |  |  |
| bookingId | `text` | não |  |  |
| externalRef | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Chaves estrangeiras:
- endpointId → ConnectionEndpoint(id)

Índices:
- `ConnectionExternalRef_bookingId_idx` ("bookingId")
- único `ConnectionExternalRef_endpointId_bookingId_key` ("endpointId", "bookingId")

## Credit

Linhas (aprox.): 273 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| description | `text` | não |  |  |
| value | `double precision` | não | `0` |  |
| bookingId | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Índices:
- único `Credit_bookingId_key` ("bookingId")

## DeliveryType

Linhas (aprox.): 68 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| name | `text` | não |  |  |
| location | `text` | sim |  |  |
| price | `double precision` | não | `0` |  |
| parkId | `text` | não |  |  |
| sortOrder | `integer` | não | `0` |  |
| callBeforeMinutes | `integer` | não | `15` |  |
| checkoutAt | `text` | sim |  |  |
| checkoutLocation | `text` | sim |  |  |

Chaves estrangeiras:
- parkId → Park(id)

## Driver

Linhas (aprox.): 48 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| firstName | `text` | não |  |  |
| lastName | `text` | não |  |  |
| email | `text` | não |  |  |
| phoneNumber | `text` | não |  |  |
| bookingId | `text` | não |  |  |

Chaves estrangeiras:
- bookingId → Booking(id)

Índices:
- `Driver_bookingId_idx` ("bookingId")

## EmailTemplate

Linhas (aprox.): 88 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| parkId | `text` | não |  |  |
| name | `text` | não |  |  |
| subject | `text` | não |  |  |
| content | `text` | não |  |  |
| type | `"EmailTemplateType"` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| active | `boolean` | não | `true` |  |
| language | `text` | sim |  |  |

Chaves estrangeiras:
- parkId → Park(id)

Índices:
- `EmailTemplate_parkId_idx` ("parkId")
- `EmailTemplate_parkId_type_idx` ("parkId", type)
- `EmailTemplate_parkId_type_language_idx` ("parkId", type, language)

## EntityEmailLog

Linhas (aprox.): 6404 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| entityType | `"LedgerEntityType"` | não |  |  |
| entityId | `text` | não |  |  |
| parkId | `text` | sim |  |  |
| emailType | `text` | não |  |  |
| recipientEmail | `text` | não |  |  |
| subject | `text` | sim |  |  |
| sentByUserId | `text` | sim |  |  |
| metadata | `jsonb` | sim |  |  |
| sentAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |

Índices:
- `EntityEmailLog_entityType_entityId_emailType_sentAt_idx` ("entityType", "entityId", "emailType", "sentAt")
- `EntityEmailLog_entityType_entityId_sentAt_idx` ("entityType", "entityId", "sentAt")

## EntityNote

Linhas (aprox.): 220 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| entityType | `"LedgerEntityType"` | não |  |  |
| entityId | `text` | não |  |  |
| parkId | `text` | sim |  |  |
| body | `text` | não |  |  |
| authorUserId | `text` | sim |  |  |
| authorName | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| sortOrder | `integer` | sim |  |  |

Índices:
- `EntityNote_entityType_entityId_createdAt_idx` ("entityType", "entityId", "createdAt")

## EntitySettlement

Linhas (aprox.): 195 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| entityType | `"LedgerEntityType"` | não |  |  |
| entityId | `text` | não |  |  |
| parkId | `text` | sim |  |  |
| scopeKey | `text` | não | `''::text` |  |
| periodKey | `text` | não |  |  |
| paidAt | `timestamp(3) without time zone` | não |  |  |
| method | `text` | sim |  |  |
| amount | `double precision` | sim |  |  |
| source | `"SettlementSource"` | não | `'AGENT'::"SettlementSource"` |  |
| recordedByUserId | `text` | sim |  |  |
| proofAttachmentId | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Índices:
- único `EntitySettlement_entityType_entityId_scopeKey_periodKey_key` ("entityType", "entityId", "scopeKey", "periodKey")

## ExtraFee

Linhas (aprox.): 4 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| name | `"FeeType"` | não |  |  |
| price | `double precision` | não |  |  |
| parkId | `text` | não |  |  |

Chaves estrangeiras:
- parkId → Park(id)

## ExtraService

Linhas (aprox.): 207 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| name | `text` | não |  |  |
| description | `text` | sim |  |  |
| price | `double precision` | não |  |  |
| parkId | `text` | não |  |  |
| sortOrder | `integer` | não | `0` |  |
| vehiclePrices | `jsonb` | sim |  |  |

Chaves estrangeiras:
- parkId → Park(id)

## Garage

Linhas (aprox.): 21 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| name | `text` | não |  |  |
| parkingType | `"ParkingType"` | não |  |  |
| totalSpots | `integer` | não | `0` |  |
| parkId | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| mapLink | `text` | sim |  |  |

Chaves estrangeiras:
- parkId → Park(id)

## History

Linhas (aprox.): 280 588 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| userId | `text` | não |  |  |
| changeType | `"ChangeType"` | não |  |  |
| modifiedFields | `text` | não |  |  |
| lat | `double precision` | sim |  |  |
| lng | `double precision` | sim |  |  |
| bookingId | `text` | não |  |  |
| actionTime | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| remarks | `text` | sim |  |  |
| platform | `text` | sim |  |  |
| userAgent | `text` | sim |  |  |
| agentName | `text` | sim |  |  |
| snapshot | `jsonb` | sim |  |  |

Chaves estrangeiras:
- bookingId → Booking(id)

## Notification

Linhas (aprox.): 27 933 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| type | `"NotificationType"` | não |  |  |
| title | `text` | não |  |  |
| message | `text` | não |  |  |
| read | `boolean` | não | `false` |  |
| readAt | `timestamp(3) without time zone` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| agentId | `text` | não |  |  |
| parkId | `text` | sim |  |  |
| bookingId | `text` | sim |  |  |
| occurrenceId | `text` | sim |  |  |
| metadata | `jsonb` | sim |  |  |
| recipientType | `"NotificationRecipientType"` | não | `'AGENT'::"NotificationRecipientType"` |  |

Chaves estrangeiras:
- parkId → Park(id)

Índices:
- `Notification_agentId_recipientType_read_createdAt_idx` ("agentId", "recipientType", read, "createdAt")
- `Notification_createdAt_idx` ("createdAt")
- `Notification_parkId_agentId_idx` ("parkId", "agentId")

## Occurrence

Linhas (aprox.): 1764 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| title | `text` | não |  |  |
| resolved | `boolean` | não | `false` |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| userId | `text` | não |  |  |
| agentName | `text` | sim |  |  |
| lat | `double precision` | sim |  |  |
| lng | `double precision` | sim |  |  |
| bookingId | `text` | sim |  |  |
| parkId | `text` | não |  |  |
| remarks | `text` | sim |  |  |
| priority | `"OccurrencePriority"` | sim | `'MEDIUM'::"OccurrencePriority"` |  |
| attachment | `text` | sim |  |  |
| resolvedAt | `timestamp(3) without time zone` | sim |  |  |
| resolvedById | `text` | sim |  |  |
| resolvedByName | `text` | sim |  |  |

Chaves estrangeiras:
- bookingId → Booking(id)
- parkId → Park(id)

## OperatingHours

Linhas (aprox.): 245 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| day | `text` | não |  |  |
| openTime | `text` | não |  |  |
| closeTime | `text` | não |  |  |
| parkId | `text` | não |  |  |

Chaves estrangeiras:
- parkId → Park(id)

## Park

Linhas (aprox.): 55 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| userId | `text` | não |  |  |
| name | `text` | não |  |  |
| email | `text` | não |  |  |
| phoneNumber | `text` | não |  |  |
| address | `text` | não |  |  |
| lat | `double precision` | não |  |  |
| lng | `double precision` | não |  |  |
| freeCancel | `boolean` | não | `false` |  |
| status | `"ParkStatus"` | sim | `'PENDING'::"ParkStatus"` |  |
| images | `text[]` | sim |  |  |
| logo | `text` | sim |  |  |
| certificate | `text` | sim |  |  |
| terms | `text` | sim |  |  |
| featured | `boolean` | não | `false` |  |
| isFull | `boolean` | não | `false` |  |
| tags | `text[]` | sim |  |  |
| types | `"ParkType"[]` | sim |  |  |
| paymentMethods | `text[]` | sim | `ARRAY['Multibanco'::text, 'Dinheiro'::text, 'Transferencia Bancária'::text, 'Onl` |  |
| occurrenceTypes | `text[]` | sim | `ARRAY['Acidente'::text, 'Vidro Aberto'::text, 'Carro Aberto'::text, 'Atraso'::te` |  |
| cancellationTypes | `text[]` | sim | `ARRAY['Cliente Cancelou'::text, 'Cliente Não Compareceu'::text, 'Erro na Reserva` |  |
| createdAt | `timestamp(3) without time zone` | sim | `CURRENT_TIMESTAMP` |  |
| city | `text` | sim |  |  |
| minTimeOfBooking | `integer` | sim | `0` |  |
| nif | `text` | sim |  |  |
| submerchantId | `text` | sim |  |  |
| country | `text` | sim |  |  |
| iban | `text` | sim |  |  |
| bic | `text` | sim |  |  |
| checkinRequireGarageSelection | `boolean` | não | `false` |  |
| checkinRequireSignature | `boolean` | não | `false` |  |
| checkinRequireVehicleKms | `boolean` | não | `false` |  |
| checkinRequireVehicleRange | `boolean` | não | `false` |  |
| checkinRequireVideo | `boolean` | não | `false` |  |
| checkinSendEmailByDefault | `boolean` | não | `false` |  |
| checkoutRequestEvaluation | `boolean` | não | `false` |  |
| checkoutRequirePaymentMethod | `boolean` | não | `false` |  |
| checkoutRequireSignature | `boolean` | não | `false` |  |
| checkoutSendEmailByDefault | `boolean` | não | `false` |  |
| allowBulkPriceValidation | `boolean` | não | `false` |  |
| backofficeViewType | `"BackofficeViewType"` | não | `'PARKING'::"BackofficeViewType"` |  |
| cityOfBirth | `text` | sim |  |  |
| dateOfBirth | `timestamp(3) without time zone` | sim |  |  |
| enableCheckingInOperation | `boolean` | não | `false` |  |
| enableCheckingOutOperation | `boolean` | não | `false` |  |
| enableMovementsOperation | `boolean` | não | `false` |  |
| enablePendingCheckoutOperation | `boolean` | não | `false` |  |
| entityType | `"EntityType"` | não | `'COR'::"EntityType"` |  |
| paymentMethodsOnCheckout | `text[]` | sim | `ARRAY['Multibanco'::text, 'Dinheiro'::text]` |  |
| website | `text` | sim |  |  |
| taxName | `text` | sim |  |  |
| taxAddress | `text` | sim |  |  |
| companyName | `text` | sim |  |  |
| slug | `text` | sim |  |  |
| timezone | `text` | não |  |  |
| syncToFirebase | `boolean` | não | `false` |  |
| firebaseBrand | `text` | sim |  |  |
| totalSpots | `integer` | não | `10` |  |
| autoEmitInvoices | `boolean` | não | `false` |  |
| autoSendInvoiceEmail | `boolean` | não | `false` |  |
| minHoursToCheckin | `integer` | não | `0` |  |
| description | `text` | sim |  |  |
| requireLocationForBookingActions | `boolean` | não | `false` |  |
| blockedWeekdays | `integer[]` | não | `ARRAY[]::integer[]` |  |
| blockedDates | `text[]` | não | `ARRAY[]::text[]` |  |
| listingType | `"ParkListingType"` | sim |  |  |

Chaves estrangeiras:
- submerchantId → Submerchant(id)

Índices:
- único `Park_slug_key` (slug)

## ParkAvailabilityBlock

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| parkId | `text` | não |  |  |
| scope | `"AvailabilityBlockScope"` | não |  |  |
| weekday | `integer` | sim |  |  |
| dayOfMonth | `integer` | sim |  |  |
| startDate | `text` | sim |  |  |
| endDate | `text` | sim |  |  |
| startTime | `text` | sim |  |  |
| endTime | `text` | sim |  |  |
| appliesTo | `"AvailabilityBlockTarget"` | não | `'BOTH'::"AvailabilityBlockTarget"` |  |
| label | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Chaves estrangeiras:
- parkId → Park(id)

Índices:
- `ParkAvailabilityBlock_parkId_idx` ("parkId")

## ParkInviteRequest

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| parkId | `text` | não |  |  |
| checkInDate | `text` | sim |  |  |
| checkOutDate | `text` | sim |  |  |
| email | `text` | sim |  |  |
| language | `text` | sim |  |  |
| sourceUrl | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |

Chaves estrangeiras:
- parkId → Park(id)

Índices:
- `ParkInviteRequest_createdAt_idx` ("createdAt")
- `ParkInviteRequest_parkId_createdAt_idx` ("parkId", "createdAt")

## Partner

Linhas (aprox.): 462 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| userId | `text` | não |  |  |
| parkId | `text` | não |  |  |
| name | `text` | sim |  |  |
| isActive | `boolean` | não | `true` |  |
| feeType | `"PartnerFeeType"` | não | `'PERCENTAGE'::"PartnerFeeType"` |  |
| feePercentage | `double precision` | sim | `10` |  |
| feeFixedValue | `double precision` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| taxAddress | `text` | sim |  |  |
| taxName | `text` | sim |  |  |
| taxNumber | `text` | sim |  |  |
| agentsAllowedToCreateBookings | `text[]` | sim |  |  |
| autoBillingEnabled | `boolean` | não | `false` |  |
| mitEnabledAt | `timestamp(3) without time zone` | sim |  |  |
| mitPaymentMethod | `text` | sim |  |  |
| mitTransactionId | `text` | sim |  |  |
| partnerType | `"PartnerType"` | não | `'AGENCY'::"PartnerType"` |  |
| maxMembers | `integer` | sim |  |  |

Chaves estrangeiras:
- parkId → Park(id)

Índices:
- `Partner_parkId_idx` ("parkId")
- `Partner_userId_idx` ("userId")
- único `Partner_userId_parkId_key` ("userId", "parkId")

## PartnerAttachment

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| type | `"AttachmentType"` | não |  |  |
| url | `text` | não |  |  |
| partnerUserId | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Índices:
- `PartnerAttachment_partnerUserId_idx` ("partnerUserId")

## PartnerCommission

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| parkId | `text` | não |  |  |
| commissionRate | `double precision` | não | `2` |  |

Chaves estrangeiras:
- parkId → Park(id)

## PartnerCreditEntry

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| partnerUserId | `text` | não |  |  |
| parkId | `text` | não |  |  |
| type | `"PartnerCreditEntryType"` | não |  |  |
| amount | `double precision` | não |  |  |
| partnerPaymentId | `text` | sim |  |  |
| source | `text` | não |  |  |
| note | `text` | sim |  |  |
| createdByUserId | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |

Índices:
- `PartnerCreditEntry_partnerPaymentId_idx` ("partnerPaymentId")
- único `PartnerCreditEntry_partnerPaymentId_parkId_type_key` ("partnerPaymentId", "parkId", type)
- `PartnerCreditEntry_partnerUserId_parkId_idx` ("partnerUserId", "parkId")

## PartnerMember

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| ownerUserId | `text` | não |  |  |
| memberUserId | `text` | sim |  |  |
| email | `text` | não |  |  |
| name | `text` | sim |  |  |
| parkIds | `text[]` | sim |  |  |
| isActive | `boolean` | não | `true` |  |
| invitedByUserId | `text` | não |  |  |
| inviteToken | `text` | sim |  |  |
| acceptedAt | `timestamp(3) without time zone` | sim |  |  |
| bookingsCreate | `boolean` | não | `false` |  |
| bookingsSimulate | `boolean` | não | `false` |  |
| bookingsViewAll | `boolean` | não | `false` |  |
| bookingsViewOwn | `boolean` | não | `false` |  |
| bookingsEdit | `boolean` | não | `false` |  |
| bookingsCancel | `boolean` | não | `false` |  |
| bookingsExport | `boolean` | não | `false` |  |
| statsView | `boolean` | não | `false` |  |
| billingView | `boolean` | não | `false` |  |
| billingPay | `boolean` | não | `false` |  |
| apiKeysManage | `boolean` | não | `false` |  |
| profileEdit | `boolean` | não | `true` |  |
| feeType | `"PartnerFeeType"` | sim |  |  |
| feeValue | `double precision` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| bookingsViewPrice | `boolean` | não | `false` |  |

Índices:
- `PartnerMember_inviteToken_idx` ("inviteToken")
- `PartnerMember_memberUserId_idx` ("memberUserId")
- único `PartnerMember_ownerUserId_email_key` ("ownerUserId", email)
- `PartnerMember_ownerUserId_idx` ("ownerUserId")
- único `PartnerMember_ownerUserId_memberUserId_key` ("ownerUserId", "memberUserId")

## PartnerPayment

Linhas (aprox.): 5 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| partnerUserId | `text` | não |  |  |
| transactionId | `text` | sim |  |  |
| amount | `double precision` | não |  |  |
| currency | `text` | não | `'EUR'::text` |  |
| status | `"PaymentStatus"` | não | `'PENDING'::"PaymentStatus"` |  |
| paymentMethod | `text` | sim |  |  |
| periodStart | `timestamp(3) without time zone` | não |  |  |
| periodEnd | `timestamp(3) without time zone` | não |  |  |
| parkSplits | `jsonb` | sim |  |  |
| bookingIds | `text[]` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| isMitCharge | `boolean` | não | `false` |  |
| mitRetryCount | `integer` | não | `0` |  |
| mitSourceTransactionId | `text` | sim |  |  |

Índices:
- `PartnerPayment_createdAt_idx` ("createdAt")
- `PartnerPayment_partnerUserId_idx` ("partnerUserId")
- `PartnerPayment_status_idx` (status)
- `PartnerPayment_transactionId_idx` ("transactionId")
- único `PartnerPayment_transactionId_key` ("transactionId")

## PartnerPaymentSplit

Linhas (aprox.): ? · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| partnerPaymentId | `text` | não |  |  |
| parkId | `text` | não |  |  |
| submerchantId | `text` | sim |  |  |
| provider | `text` | sim |  |  |
| amount | `double precision` | não |  |  |
| commissionPercentage | `double precision` | sim |  |  |
| commissionAmount | `double precision` | sim |  |  |
| netAmount | `double precision` | sim |  |  |
| status | `"PlatformSplitStatus"` | não |  |  |
| splitTransactionId | `text` | sim |  |  |
| failedReason | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Chaves estrangeiras:
- partnerPaymentId → PartnerPayment(id)

Índices:
- `PartnerPaymentSplit_parkId_createdAt_idx` ("parkId", "createdAt")
- único `PartnerPaymentSplit_partnerPaymentId_parkId_key` ("partnerPaymentId", "parkId")

## Pricing

Linhas (aprox.): 144 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| parkingType | `"ParkingType"` | não |  |  |
| vehicleType | `"VehicleSize"` | não |  |  |
| pricingType | `"PricingType"` | não |  |  |
| price | `double precision` | não |  |  |
| parkId | `text` | não |  |  |

Chaves estrangeiras:
- parkId → Park(id)

## Procedures

Linhas (aprox.): 110 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| title | `text` | não |  |  |
| steps | `text[]` | sim |  |  |
| parkId | `text` | não |  |  |

Chaves estrangeiras:
- parkId → Park(id)

## ProClient

Linhas (aprox.): 61 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| clientId | `text` | não |  |  |
| discount | `double precision` | não | `15` |  |
| parkId | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| name | `text` | sim |  |  |
| active | `boolean` | não | `true` |  |
| deactivatedAt | `timestamp(3) without time zone` | sim |  |  |
| taxName | `text` | sim |  |  |
| taxNumber | `text` | sim |  |  |
| iban | `text` | sim |  |  |

Chaves estrangeiras:
- clientId → Client(id)
- parkId → Park(id)

Índices:
- único `ProClient_clientId_parkId_key` ("clientId", "parkId")

## ProClientAttachment

Linhas (aprox.): 209 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| type | `"AttachmentType"` | não |  |  |
| url | `text` | não |  |  |
| clientId | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Índices:
- `ProClientAttachment_clientId_idx` ("clientId")

## ProPayment

Linhas (aprox.): 22 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| clientId | `text` | não |  |  |
| transactionId | `text` | sim |  |  |
| amount | `double precision` | não |  |  |
| currency | `text` | não | `'EUR'::text` |  |
| status | `"PaymentStatus"` | não | `'PENDING'::"PaymentStatus"` |  |
| paymentMethod | `text` | sim |  |  |
| periodStart | `timestamp(3) without time zone` | não |  |  |
| periodEnd | `timestamp(3) without time zone` | não |  |  |
| parkSplits | `jsonb` | sim |  |  |
| bookingIds | `text[]` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| isMitCharge | `boolean` | não | `false` |  |
| mitRetryCount | `integer` | não | `0` |  |
| mitSourceTransactionId | `text` | sim |  |  |

Índices:
- `ProPayment_clientId_idx` ("clientId")
- `ProPayment_createdAt_idx` ("createdAt")
- `ProPayment_status_idx` (status)
- `ProPayment_transactionId_idx` ("transactionId")
- único `ProPayment_transactionId_key` ("transactionId")

## SavedBookingFilter

Linhas (aprox.): 2 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| userId | `text` | não |  |  |
| name | `text` | não |  |  |
| description | `text` | sim |  |  |
| filters | `jsonb` | não |  |  |
| isDefault | `boolean` | não | `false` |  |
| lastUsedAt | `timestamp(3) without time zone` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Índices:
- `SavedBookingFilter_userId_createdAt_idx` ("userId", "createdAt")
- único `SavedBookingFilter_userId_name_key` ("userId", name)

## Spot

Linhas (aprox.): 1641 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| row | `text` | não |  |  |
| spot | `text` | não |  |  |
| size | `"VehicleSize"` | sim | `'CAR'::"VehicleSize"` |  |
| isReserved | `boolean` | não | `false` |  |
| available | `boolean` | não | `true` |  |
| hasCharger | `boolean` | não | `false` |  |
| chargerPower | `"ChargerPower"` | sim |  |  |
| garageId | `text` | não |  |  |

Chaves estrangeiras:
- garageId → Garage(id)

Índices:
- único `Spot_garageId_row_spot_key` ("garageId", "row", spot)
- `idx_row_spot_garage` ("row", spot, "garageId")

## Submerchant

Linhas (aprox.): 25 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| submerchantId | `text` | não |  |  |
| settlementTypeCode | `text` | não |  |  |
| refundMaxAmount | `double precision` | não | `0.0` |  |
| payoutTypeCode | `text` | não | `'MAN'::text` |  |
| deferredAgreementDays | `integer` | não | `0` |  |
| feeFixedValue | `double precision` | não | `0.0` |  |
| feePercentage | `double precision` | não | `0.0` |  |
| splitFeeMinAmount | `double precision` | não | `0.0` |  |
| splitFeeMaxAmount | `double precision` | não | `0.0` |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| provider | `text` | não | `'SIBS'::text` |  |
| onboardingComplete | `boolean` | não | `true` |  |
| providerMetadata | `jsonb` | sim |  |  |
| onboardingReminderSentAt | `timestamp(3) without time zone` | sim |  |  |

## Subscription

Linhas (aprox.): 1449 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| userId | `text` | não |  |  |
| plan | `"MultiparkPlans"` | não | `'FREE'::"MultiparkPlans"` |  |
| status | `"SubscriptionStatus"` | não | `'ACTIVE'::"SubscriptionStatus"` |  |
| agentCount | `integer` | não | `0` |  |
| maxAgents | `integer` | não | `0` |  |
| parkCount | `integer` | não | `0` |  |
| maxParks | `integer` | não | `1` |  |
| featuredInMarketplace | `boolean` | não | `false` |  |
| allowManualReservations | `boolean` | não | `false` |  |
| allowCashboxView | `boolean` | não | `false` |  |
| allowStatsView | `boolean` | não | `false` |  |
| allowProcessesView | `boolean` | não | `false` |  |
| allowOccurrencesView | `boolean` | não | `false` |  |
| allowAgentsView | `boolean` | não | `false` |  |
| allowSettingsView | `boolean` | não | `false` |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| allowBulkImportBookings | `boolean` | não | `false` |  |
| allowExportAgentHistory | `boolean` | não | `false` |  |
| allowExportBookingHistory | `boolean` | não | `false` |  |
| allowExportBookings | `boolean` | não | `false` |  |
| allowExportOccurrences | `boolean` | não | `false` |  |
| cancelAtPeriodEnd | `boolean` | não | `false` |  |
| currentPeriodEnd | `timestamp(3) without time zone` | sim |  |  |
| currentPeriodStart | `timestamp(3) without time zone` | sim |  |  |
| lastPaymentAmount | `double precision` | sim |  |  |
| lastPaymentDate | `timestamp(3) without time zone` | sim |  |  |
| nextBillingDate | `timestamp(3) without time zone` | sim |  |  |
| allowGaragesView | `boolean` | não | `false` |  |
| allowViewApiKeys | `boolean` | não | `false` |  |
| allowViewCampaigns | `boolean` | não | `false` |  |
| allowEditEmail | `boolean` | não | `false` |  |
| allowEmailView | `boolean` | não | `false` |  |
| allowClientsView | `boolean` | não | `false` |  |
| allowProsView | `boolean` | não | `false` |  |
| allowReviewsView | `boolean` | não | `false` |  |
| allowSearchView | `boolean` | não | `false` |  |
| mitTransactionId | `text` | sim |  |  |
| mitPaymentMethod | `text` | sim |  |  |
| mitEnabledAt | `timestamp(3) without time zone` | sim |  |  |
| mitRetryCount | `integer` | não | `0` |  |
| mitLastRetryAt | `timestamp(3) without time zone` | sim |  |  |
| autoRenewalEnabled | `boolean` | não | `true` |  |
| allowAllowancesView | `boolean` | não | `false` |  |

Índices:
- único `Subscription_userId_key` ("userId")

## SubscriptionPayment

Linhas (aprox.): 10 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| subscriptionId | `text` | não |  |  |
| transactionId | `text` | não |  |  |
| amount | `double precision` | não |  |  |
| currency | `text` | não | `'EUR'::text` |  |
| status | `"PaymentStatus"` | não | `'PENDING'::"PaymentStatus"` |  |
| billingPeriodStart | `timestamp(3) without time zone` | não |  |  |
| billingPeriodEnd | `timestamp(3) without time zone` | não |  |  |
| paymentMethod | `text` | sim |  |  |
| failureReason | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| plan | `"MultiparkPlans"` | sim |  |  |
| isMitCharge | `boolean` | não | `false` |  |

Chaves estrangeiras:
- subscriptionId → Subscription(id)

Índices:
- `SubscriptionPayment_status_idx` (status)
- `SubscriptionPayment_subscriptionId_idx` ("subscriptionId")
- `SubscriptionPayment_transactionId_idx` ("transactionId")
- único `SubscriptionPayment_transactionId_key` ("transactionId")

## UserPreference

Linhas (aprox.): 94 · PK: userId

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| userId | `text` | não |  |  |
| language | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

## Vehicle

Linhas (aprox.): 10 879 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| ownerId | `text` | não |  |  |
| licensePlate | `text` | não |  |  |
| brand | `text` | não |  |  |
| model | `text` | não |  |  |
| color | `text` | não |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| vehicleType | `"VehicleSize"` | não | `'CAR'::"VehicleSize"` |  |
| deletedAt | `timestamp(3) without time zone` | sim |  |  |
| isDeleted | `boolean` | não | `false` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |

Índices:
- único `Vehicle_licensePlate_ownerId_key` ("licensePlate", "ownerId")

## WebsiteCheckout

Linhas (aprox.): 594 · PK: id

| Coluna | Tipo | Nulo | Omissão | Nota |
|---|---|:---:|---|---|
| id | `text` | não |  |  |
| draftId | `text` | não |  |  |
| parkId | `text` | não |  |  |
| payload | `jsonb` | não |  |  |
| quote | `jsonb` | não |  |  |
| amountCents | `integer` | não |  |  |
| pricedAt | `timestamp(3) without time zone` | não |  |  |
| paymentRequired | `boolean` | não |  |  |
| paymentIntentId | `text` | sim |  |  |
| status | `"WebsiteCheckoutStatus"` | não | `'OPEN'::"WebsiteCheckoutStatus"` |  |
| bookingId | `text` | sim |  |  |
| invoice | `jsonb` | sim |  |  |
| finalizeAttempts | `integer` | não | `0` |  |
| lastError | `text` | sim |  |  |
| createdAt | `timestamp(3) without time zone` | não | `CURRENT_TIMESTAMP` |  |
| updatedAt | `timestamp(3) without time zone` | não |  |  |
| finalizingUntil | `timestamp(3) without time zone` | sim |  |  |
| blockedReason | `text` | sim |  |  |
| alertSentAt | `timestamp(3) without time zone` | sim |  |  |
| redactedAt | `timestamp(3) without time zone` | sim |  |  |

Índices:
- único `WebsiteCheckout_bookingId_key` ("bookingId")
- único `WebsiteCheckout_draftId_key` ("draftId")
- `WebsiteCheckout_parkId_idx` ("parkId")
- único `WebsiteCheckout_paymentIntentId_key` ("paymentIntentId")
- `WebsiteCheckout_status_createdAt_idx` (status, "createdAt")
- `WebsiteCheckout_status_finalizingUntil_idx` (status, "finalizingUntil")
- `WebsiteCheckout_status_redactedAt_idx` (status, "redactedAt")

