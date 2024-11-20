import { Inject, Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { User, WebhookEvent } from '@octokit/webhooks-types';
import { Colors, EmbedBuilder, MessageFlags } from 'discord.js';
import _ from 'lodash';
import semver from 'semver';
import { getConfig } from 'src/config';
import { Constants, ReleaseMessages } from 'src/constants';
import { GithubStatusComponent, GithubStatusIncident, PaymentIntent, StripeBase } from 'src/dtos/webhook.dto';
import { IDatabaseRepository } from 'src/interfaces/database.interface';
import { DiscordChannel, IDiscordInterface } from 'src/interfaces/discord.interface';
import { IZulipInterface } from 'src/interfaces/zulip.interface';
import { makeLicenseFields, shorten, withErrorLogging } from 'src/util';

const isIncidentUpdate = (dto: GithubStatusComponent | GithubStatusIncident): dto is GithubStatusIncident => {
  return !!(dto as GithubStatusIncident).incident;
};

const isPaymentEvent = (payload: StripeBase): payload is StripeBase<PaymentIntent> =>
  payload.data.object.object === 'payment_intent';

const isImmichProduct = (payload: StripeBase<PaymentIntent>) =>
  ['immich-server', 'immich-client'].includes(payload.data.object.description);

const isMainRepo = (name: string) => name === 'immich-app/immich';

type BaseEvent = {
  number: number;
  title: string;
  user: User;
  html_url: string;
  body: string | null;
};

@Injectable()
export class WebhookService {
  private logger = new Logger(WebhookService.name);

  constructor(
    @Inject(IDatabaseRepository) private database: IDatabaseRepository,
    @Inject(IDiscordInterface) private discord: IDiscordInterface,
    @Inject(IZulipInterface) private zulip: IZulipInterface,
  ) {}

  async onGithub(dto: WebhookEvent, slug: string) {
    const { slugs } = getConfig();
    if (!slugs.githubWebhook || slug !== slugs.githubWebhook) {
      throw new UnauthorizedException();
    }

    if (!('action' in dto)) {
      return;
    }

    const { action } = dto;

    if (
      'pull_request' in dto &&
      (action === 'opened' || action === 'closed' || action === 'converted_to_draft' || action === 'ready_for_review')
    ) {
      const embed = this.getEmbed({
        action,
        repositoryName: dto.repository.full_name,
        title: 'Pull request',
        user: dto.sender,
        event: dto.pull_request,
      });
      const color = this.getPrEmbedColor({
        action,
        isDraft: dto.pull_request.draft,
        isMerged: dto.pull_request.merged,
      });
      embed.setColor(color);

      await this.discord.sendMessage({ channel: DiscordChannel.PullRequests, message: { embeds: [embed] } });
      return;
    }

    if ('issue' in dto && (action === 'opened' || action === 'reopened' || action === 'closed')) {
      const embed = this.getEmbed({
        action,
        repositoryName: dto.repository.full_name,
        title: 'Issue',
        user: dto.sender,
        event: dto.issue,
      });
      embed.setColor(this.getIssueEmbedColor({ action }));

      await this.discord.sendMessage({ channel: DiscordChannel.IssuesAndDiscussions, message: { embeds: [embed] } });
      return;
    }

    if ('discussion' in dto && (action === 'created' || action === 'deleted' || action === 'answered')) {
      const embed = this.getEmbed({
        action,
        repositoryName: dto.repository.full_name,
        title: 'Discussion',
        user: dto.sender,
        event: dto.discussion,
      });
      embed.setColor(this.getDiscussionEmbedColor({ action }));

      await this.discord.sendMessage({ channel: DiscordChannel.IssuesAndDiscussions, message: { embeds: [embed] } });
      return;
    }

    if ('release' in dto && action === 'released') {
      const embedProps = {
        repositoryName: dto.repository.full_name,
        name: dto.release.name,
        url: dto.release.html_url,
        user: dto.sender,
        description: isMainRepo(dto.repository.full_name) ? _.sample(ReleaseMessages) : undefined,
      };
      const messages = [
        this.discord.sendMessage({
          channel: DiscordChannel.Releases,
          message: {
            embeds: [this.getReleaseEmbed(embedProps)],
          },
          crosspost: true,
        }),
      ];

      if (isMainRepo(dto.repository.full_name)) {
        if (semver.patch(dto.release.tag_name) === 0) {
          messages.push(
            this.discord.sendMessage({
              channel: DiscordChannel.Announcements,
              message: {
                embeds: [this.getReleaseEmbed(embedProps)],
              },
              crosspost: true,
            }),
          );
        }

        messages.push(
          this.zulip.sendMessage({
            stream: Constants.Zulip.Streams.Immich,
            topic: Constants.Zulip.Topics.ImmichRelease,
            content: `${embedProps.description!} ${dto.release.html_url}`,
          }),
        );
      }

      await Promise.all(messages);
    }
  }

  async onGithubStatus(dto: GithubStatusIncident | GithubStatusComponent, slug: string) {
    const { slugs } = getConfig();
    if (!slugs.githubStatusWebhook || slug !== slugs.githubStatusWebhook) {
      throw new UnauthorizedException();
    }

    this.logger.debug(dto);

    if (isIncidentUpdate(dto)) {
      const embed = new EmbedBuilder({
        title: dto.page.status_description,
        author: { name: 'GitHub Status', url: 'https://githubstatus.com' },
        url: dto.incident.shortlink,
        fields: [{ name: dto.incident.name, value: dto.incident.incident_updates[0].body.replaceAll('<br />', '\n') }],
      });

      if (dto.incident.status === 'resolved') {
        embed.setColor('Green');
      } else {
        switch (dto.incident.impact) {
          case 'minor':
            embed.setColor('Orange');
            break;
          case 'major':
            embed.setColor('Red');
            break;
          default:
            embed.setColor('Grey');
        }
      }

      await this.discord.sendMessage({ channel: DiscordChannel.GithubStatus, message: { embeds: [embed] } });
    }
  }

  onStripePayment(dto: StripeBase, slug: string) {
    const { slugs } = getConfig();
    if (!slugs.stripeWebhook || slug !== slugs.stripeWebhook) {
      throw new UnauthorizedException();
    }

    if (isPaymentEvent(dto) && isImmichProduct(dto)) {
      void this.handleStripePayment(dto);
    }
  }

  private async handleStripePayment(event: StripeBase<PaymentIntent>) {
    const { id, description, amount, created, currency, status, livemode } = event.data.object;

    await withErrorLogging({
      method: () =>
        this.database.createPayment({
          event_id: event.id,
          id,
          amount,
          currency,
          status,
          description,
          created,
          livemode,
          data: JSON.stringify(event),
        }),
      message: 'Failed to insert payment into database',
      fallbackValue: undefined,
      discord: this.discord,
      logger: this.logger,
    });

    if (status !== 'succeeded') {
      return;
    }

    const { server, client } = await withErrorLogging({
      method: () => this.database.getTotalLicenseCount(),
      message: 'Failed to insert payment into database',
      fallbackValue: { server: 0, client: 0 },
      discord: this.discord,
      logger: this.logger,
    });

    const licenseType = description.split('-')[1];
    await this.discord.sendMessage({
      channel: DiscordChannel.Stripe,
      message: {
        embeds: [
          new EmbedBuilder()
            .setTitle(`${livemode ? '' : 'TEST PAYMENT - '}Immich ${licenseType} license purchased`)
            .setURL(`https://dashboard.stripe.com/${livemode ? '' : 'test/'}payments/${id}`)
            .setAuthor({ name: 'Stripe Payments', url: 'https://stripe.com' })
            .setDescription(`Price: ${(amount / 100).toLocaleString()} ${currency.toUpperCase()}`)
            .setColor(livemode ? Colors.Green : Colors.Yellow)
            .setFields(makeLicenseFields({ server, client })),
        ],
        flags: [MessageFlags.SuppressNotifications],
      },
    });
  }

  private getReleaseEmbed({
    repositoryName,
    name,
    user,
    url,
    description,
  }: {
    repositoryName: string;
    name: string;
    user: User;
    url: string;
    description?: string;
  }) {
    return new EmbedBuilder({
      title: `[${repositoryName}] New release: ${name}`,
      author: { name: user.login, url: user.html_url, iconURL: user.avatar_url },
      url,
      description,
    });
  }

  private getEmbed({
    action,
    repositoryName,
    title,
    user,
    event,
  }: {
    action: string;
    repositoryName: string;
    title: string;
    user: User;
    event: BaseEvent;
  }) {
    return new EmbedBuilder({
      title: `[${repositoryName}] ${title} ${action}: #${event.number} ${event.title}`,
      author: {
        name: user.login,
        url: user.html_url,
        iconURL: user.avatar_url,
      },
      url: event.html_url,
      description:
        action === 'opened' || action === 'created' ? (event.body ? shorten(event.body, 500) : undefined) : undefined,
    });
  }

  private getPrEmbedColor(dto: {
    action: 'opened' | 'closed' | 'converted_to_draft' | 'ready_for_review';
    isDraft: boolean;
    isMerged: boolean | null;
  }) {
    switch (dto.action) {
      case 'opened': {
        return dto.isDraft ? 'Grey' : 'Green';
      }
      case 'closed': {
        if (dto.isMerged === null) {
          this.logger.error('Closed PR should have isMerged set.');
          return null;
        }
        return dto.isMerged ? 'Purple' : 'Red';
      }
      case 'converted_to_draft': {
        return 'Grey';
      }
      case 'ready_for_review': {
        return 'Green';
      }
    }
  }

  private getIssueEmbedColor(dto: { action: 'opened' | 'reopened' | 'closed' }) {
    switch (dto.action) {
      case 'opened': {
        return 'Green';
      }
      case 'reopened': {
        return 'DarkGreen';
      }
      case 'closed': {
        return 'NotQuiteBlack';
      }
    }
  }

  private getDiscussionEmbedColor(dto: { action: 'created' | 'deleted' | 'answered' }) {
    switch (dto.action) {
      case 'created': {
        return 'Orange';
      }
      case 'deleted': {
        return 'NotQuiteBlack';
      }
      case 'answered': {
        return 'Green';
      }
    }
  }
}
