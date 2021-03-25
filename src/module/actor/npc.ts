import { ActorPF2e, SKILL_DICTIONARY, SKILL_EXPANDED } from './base';
import { ItemPF2e } from '@item/base';
import { CheckModifier, ModifierPF2e, MODIFIER_TYPE, StatisticModifier } from '../modifiers';
import { PF2WeaponDamage } from '../system/damage/weapon';
import { CheckPF2e, PF2DamageRoll } from '../system/rolls';
import { CharacterStrikeTrait, NPCData, NPCStrike } from './data-definitions';
import { RuleElements } from '../rules/rules';
import { PF2RollNote } from '../notes';
import { adaptRoll } from '@system/rolls';
import { CreaturePF2e } from '@actor/creature';
import { ConfigPF2e } from '@scripts/config';
import { ActionData, MeleeData } from '@item/data-definitions';

export class NPCPF2e extends CreaturePF2e {
    /** Prepare Character type specific data. */
    prepareDerivedData(): void {
        super.prepareDerivedData();
        const actorData = this.data;
        const { data } = actorData;

        const rules = actorData.items.reduce(
            (accumulated, current) => accumulated.concat(RuleElements.fromOwnedItem(current)),
            [],
        );

        // Toggles
        (data as any).toggles = {
            actions: [
                {
                    label: 'PF2E.TargetFlatFootedLabel',
                    inputName: `flags.${game.system.id}.rollOptions.all.target:flatFooted`,
                    checked: this.getFlag(game.system.id, 'rollOptions.all.target:flatFooted'),
                },
            ],
        };

        const { statisticsModifiers, damageDice, strikes, rollNotes } = this._prepareCustomModifiers(actorData, rules);

        // Compute 'fake' ability scores from ability modifiers (just in case the scores are required for something)
        for (const abl of Object.values(actorData.data.abilities)) {
            abl.mod = Number(abl.mod ?? 0); // ensure the modifier is never a string
            abl.value = abl.mod * 2 + 10;
        }

        // Hit Points
        {
            const base: number = data.attributes.hp.base ?? data.attributes.hp.value;
            const modifiers: ModifierPF2e[] = [];
            (statisticsModifiers.hp || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
            (statisticsModifiers['hp-per-level'] || [])
                .map((m) => duplicate(m))
                .forEach((m) => {
                    m.modifier *= data.details.level.value;
                    modifiers.push(m);
                });

            const stat = mergeObject(new StatisticModifier('hp', modifiers), data.attributes.hp, {
                overwrite: false,
            });

            stat.base = base;
            stat.max = base + stat.totalModifier;
            stat.value = Math.min(stat.value, stat.max); // Make sure the current HP isn't higher than the max HP
            stat.breakdown = [
                game.i18n.format('PF2E.MaxHitPointsBaseLabel', { base }),
                ...stat.modifiers
                    .filter((m) => m.enabled)
                    .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`),
            ].join(', ');

            data.attributes.hp = stat;
        }

        // Speeds
        {
            const label = game.i18n.localize('PF2E.SpeedTypesLand');
            const base = parseInt(data.attributes.speed.value, 10) || 0;
            const modifiers: ModifierPF2e[] = [];
            ['land-speed', 'speed'].forEach((key) => {
                (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
            });
            const stat = mergeObject(
                new StatisticModifier(game.i18n.format('PF2E.SpeedLabel', { type: label }), modifiers),
                data.attributes.speed,
                { overwrite: false },
            );
            stat.total = base + stat.totalModifier;
            stat.type = 'land';
            stat.breakdown = [`${game.i18n.format('PF2E.SpeedBaseLabel', { type: label })} ${base}`]
                .concat(
                    stat.modifiers
                        .filter((m) => m.enabled)
                        .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`),
                )
                .join(', ');
            data.attributes.speed = stat;
        }
        for (let idx = 0; idx < data.attributes.speed.otherSpeeds.length; idx++) {
            const speed = data.attributes.speed.otherSpeeds[idx];
            const base = typeof speed.value === 'string' ? parseInt(speed.value, 10) || 0 : 0;
            const modifiers: ModifierPF2e[] = [];
            [`${speed.type.toLowerCase()}-speed`, 'speed'].forEach((key) => {
                (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
            });
            const stat = mergeObject(
                new StatisticModifier(game.i18n.format('PF2E.SpeedLabel', { type: speed.type }), modifiers),
                speed,
                { overwrite: false },
            );
            stat.total = base + stat.totalModifier;
            stat.breakdown = [`${game.i18n.format('PF2E.SpeedBaseLabel', { type: speed.type })} ${base}`]
                .concat(
                    stat.modifiers
                        .filter((m) => m.enabled)
                        .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`),
                )
                .join(', ');
            data.attributes.speed.otherSpeeds[idx] = stat;
        }

        // Armor Class
        {
            const base: number = data.attributes.ac.base ?? Number(data.attributes.ac.value);
            const dexterity = Math.min(
                data.abilities.dex.mod,
                ...(data.attributes.dexCap ?? []).map((cap) => cap.value),
            );
            const modifiers = [
                new ModifierPF2e('PF2E.BaseModifier', base - 10 - dexterity, MODIFIER_TYPE.UNTYPED),
                new ModifierPF2e(CONFIG.PF2E.abilities.dex, dexterity, MODIFIER_TYPE.ABILITY),
            ];
            ['ac', 'dex-based', 'all'].forEach((key) => {
                (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
            });

            const stat = mergeObject(new StatisticModifier('ac', modifiers), data.attributes.ac, {
                overwrite: false,
            });
            stat.base = base;
            stat.value = 10 + stat.totalModifier;
            stat.breakdown = [game.i18n.localize('PF2E.ArmorClassBase')]
                .concat(
                    stat.modifiers
                        .filter((m) => m.enabled)
                        .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`),
                )
                .join(', ');

            data.attributes.ac = stat;
        }

        // Shield
        {
            const shield = this.getFirstEquippedShield();
            if (shield) {
                // Use shield item data
                const isBroken = shield.data.hp.value <= shield.data.brokenThreshold.value;
                const shieldData = {
                    value: shield.data.hp.value,
                    max: shield.data.maxHp.value,
                    ac: isBroken ? 0 : shield.data.armor.value,
                    hardness: shield.data.hardness.value,
                    brokenThreshold: shield.data.brokenThreshold.value,
                };
                data.attributes.shield = shieldData;
            } else {
                if (!data.attributes.shield.max) {
                    // No shield and no existing data
                    const shieldData = {
                        value: 0,
                        max: 0,
                        ac: 0,
                        hardness: 0,
                        brokenThreshold: 0,
                    };
                    data.attributes.shield = shieldData;
                } else {
                    // Use existing data
                    const isBroken =
                        Number(data.attributes.shield.value) <= Number(data.attributes.shield.brokenThreshold);
                    if (isBroken) {
                        data.attributes.shield.ac = 0;
                    }
                }
            }
        }

        // Saving Throws
        for (const [saveName, save] of Object.entries(data.saves as Record<string, any>)) {
            const base: number = save.base ?? Number(save.value);
            const modifiers = [
                new ModifierPF2e('PF2E.BaseModifier', base - data.abilities[save.ability].mod, MODIFIER_TYPE.UNTYPED),
                new ModifierPF2e(
                    CONFIG.PF2E.abilities[save.ability],
                    data.abilities[save.ability].mod,
                    MODIFIER_TYPE.ABILITY,
                ),
            ];
            const notes = [] as PF2RollNote[];
            [saveName, `${save.ability}-based`, 'saving-throw', 'all'].forEach((key) => {
                (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
                (rollNotes[key] ?? []).map((n) => duplicate(n)).forEach((n) => notes.push(n));
            });

            const stat = mergeObject(new StatisticModifier(saveName, modifiers), save, {
                overwrite: false,
            });
            stat.base = base;
            stat.value = stat.totalModifier;
            stat.breakdown = stat.modifiers
                .filter((m) => m.enabled)
                .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`)
                .join(', ');
            stat.roll = adaptRoll((args) => {
                const label = game.i18n.format('PF2E.SavingThrowWithName', {
                    saveName: game.i18n.localize(CONFIG.PF2E.saves[saveName]),
                });
                CheckPF2e.roll(
                    new CheckModifier(label, stat),
                    { actor: this, type: 'saving-throw', options: args.options, notes },
                    args.event,
                    args.callback,
                );
            });

            data.saves[saveName] = stat;
        }

        // Perception
        {
            const base: number = data.attributes.perception.base ?? Number(data.attributes.perception.value);
            const modifiers = [
                new ModifierPF2e('PF2E.BaseModifier', base - data.abilities.wis.mod, MODIFIER_TYPE.UNTYPED),
                new ModifierPF2e(CONFIG.PF2E.abilities.wis, data.abilities.wis.mod, MODIFIER_TYPE.ABILITY),
            ];
            const notes = [] as PF2RollNote[];
            ['perception', 'wis-based', 'all'].forEach((key) => {
                (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
                (rollNotes[key] ?? []).map((n) => duplicate(n)).forEach((n) => notes.push(n));
            });

            const stat = mergeObject(new StatisticModifier('perception', modifiers), data.attributes.perception, {
                overwrite: false,
            });
            stat.base = base;
            stat.value = stat.totalModifier;
            stat.breakdown = stat.modifiers
                .filter((m) => m.enabled)
                .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`)
                .join(', ');
            stat.roll = adaptRoll((args) => {
                const label = game.i18n.localize('PF2E.PerceptionCheck');
                CheckPF2e.roll(
                    new CheckModifier(label, stat),
                    { actor: this, type: 'perception-check', options: args.options ?? [], notes },
                    args.event,
                    args.callback,
                );
            });

            data.attributes.perception = stat;
        }

        // default all skills to untrained
        data.skills = {};
        for (const [skill, { ability, shortform }] of Object.entries(SKILL_EXPANDED)) {
            const modifiers = [
                new ModifierPF2e('PF2E.BaseModifier', 0, MODIFIER_TYPE.UNTYPED),
                new ModifierPF2e(CONFIG.PF2E.abilities[ability], data.abilities[ability].mod, MODIFIER_TYPE.ABILITY),
            ];
            const notes = [] as PF2RollNote[];
            [skill, `${ability}-based`, 'skill-check', 'all'].forEach((key) => {
                (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
                (rollNotes[key] ?? []).map((n) => duplicate(n)).forEach((n) => notes.push(n));
            });

            const name = game.i18n.localize(`PF2E.Skill${SKILL_DICTIONARY[shortform].capitalize()}`);
            const stat = mergeObject(
                new StatisticModifier(name, modifiers),
                {
                    ability,
                    expanded: skill,
                    label: name,
                    visible: false,
                },
                { overwrite: false },
            );
            stat.lore = false;
            stat.rank = 0; // default to untrained
            stat.value = stat.totalModifier;
            stat.breakdown = stat.modifiers
                .filter((m) => m.enabled)
                .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`)
                .join(', ');
            stat.roll = (event, options = [], callback?) => {
                const label = game.i18n.format('PF2E.SkillCheckWithName', { skillName: name });
                CheckPF2e.roll(
                    new CheckModifier(label, stat),
                    { actor: this, type: 'skill-check', options, notes },
                    event,
                    callback,
                );
            };
            data.skills[shortform] = stat;
        }

        // Automatic Actions
        data.actions = [];

        // process OwnedItem instances, which for NPCs include skills, attacks, equipment, special abilities etc.
        for (const item of actorData.items.concat(strikes)) {
            if (item.type === 'lore') {
                // override untrained skills if defined in the NPC data
                const skill = item.name.slugify(); // normalize skill name to lower-case and dash-separated words
                // assume lore, if skill cannot be looked up
                const { ability, shortform } = SKILL_EXPANDED[skill] ?? { ability: 'int', shortform: skill };

                const base: number = (item.data.mod as any).base ?? Number(item.data.mod.value);
                const modifiers = [
                    new ModifierPF2e('PF2E.BaseModifier', base - data.abilities[ability].mod, MODIFIER_TYPE.UNTYPED),
                    new ModifierPF2e(
                        CONFIG.PF2E.abilities[ability],
                        data.abilities[ability].mod,
                        MODIFIER_TYPE.ABILITY,
                    ),
                ];
                const notes = [] as PF2RollNote[];
                [skill, `${ability}-based`, 'skill-check', 'all'].forEach((key) => {
                    (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
                    (rollNotes[key] ?? []).map((n) => duplicate(n)).forEach((n) => notes.push(n));
                });

                const stat = mergeObject(new StatisticModifier(item.name, modifiers), data.skills[shortform], {
                    overwrite: false,
                });
                stat.itemID = item._id;
                stat.base = base;
                stat.expanded = skill;
                stat.label = item.name;
                stat.lore = !SKILL_EXPANDED[skill];
                stat.rank = 1; // default to trained
                stat.value = stat.totalModifier;
                stat.visible = true;
                stat.breakdown = stat.modifiers
                    .filter((m) => m.enabled)
                    .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`)
                    .join(', ');
                stat.roll = adaptRoll((args) => {
                    const label = game.i18n.format('PF2E.SkillCheckWithName', { skillName: item.name });
                    CheckPF2e.roll(
                        new CheckModifier(label, stat),
                        { actor: this, type: 'skill-check', options: args.options ?? [], dc: args.dc, notes },
                        args.event,
                        args.callback,
                    );
                });

                const variants = (item.data as any).variants;
                if (variants && Object.keys(variants).length) {
                    stat.variants = [];
                    for (const [, variant] of Object.entries(variants)) {
                        stat.variants.push(variant);
                    }
                }

                data.skills[shortform] = stat;
            } else if (item.type === 'melee') {
                const modifiers: ModifierPF2e[] = [];
                const notes = [] as PF2RollNote[];

                // traits
                const traits = item.data.traits.value;

                // Determine the base ability score for this attack.
                let ability: string;
                {
                    ability = item.data.weaponType?.value === 'ranged' ? 'dex' : 'str';
                    const bonus = Number(item.data?.bonus?.value ?? 0);
                    if (traits.includes('finesse')) {
                        ability = 'dex';
                    } else if (traits.includes('brutal')) {
                        ability = 'str';
                    }
                    modifiers.push(
                        new ModifierPF2e(
                            'PF2E.BaseModifier',
                            bonus - data.abilities[ability].mod,
                            MODIFIER_TYPE.UNTYPED,
                        ),
                        new ModifierPF2e(
                            CONFIG.PF2E.abilities[ability],
                            data.abilities[ability].mod,
                            MODIFIER_TYPE.ABILITY,
                        ),
                    );
                }

                // Conditions and Custom modifiers to attack rolls
                {
                    const stats: string[] = [];
                    stats.push(`${item.name.replace(/\s+/g, '-').toLowerCase()}-attack`); // convert white spaces to dash and lower-case all letters
                    stats
                        .concat([
                            'attack',
                            `${ability}-attack`,
                            `${ability}-based`,
                            `${item._id}-attack`,
                            'attack-roll',
                            'all',
                        ])
                        .forEach((key) => {
                            (statisticsModifiers[key] || []).map((m) => duplicate(m)).forEach((m) => modifiers.push(m));
                            (rollNotes[key] ?? []).map((n) => duplicate(n)).forEach((n) => notes.push(n));
                        });
                }

                // action image
                const { imageUrl, actionGlyph } = ActorPF2e.getActionGraphics(
                    (item as any).data?.actionType?.value || 'action',
                    parseInt(((item as any).data?.actions || {}).value, 10) || 1,
                );

                const action = new StatisticModifier(item.name, modifiers) as NPCStrike;
                action.glyph = actionGlyph;
                action.imageUrl = imageUrl;
                action.sourceId = item._id;
                action.type = 'strike';
                action.description = item.data.description.value || '';
                action.attackRollType =
                    item.data.weaponType?.value === 'ranged' ? 'PF2E.NPCAttackRanged' : 'PF2E.NPCAttackMelee';
                action.breakdown = action.modifiers
                    .filter((m) => m.enabled)
                    .map((m) => `${game.i18n.localize(m.name)} ${m.modifier < 0 ? '' : '+'}${m.modifier}`)
                    .join(', ');

                action.traits = [
                    { name: 'attack', label: game.i18n.localize('PF2E.TraitAttack'), toggle: false },
                ].concat(
                    traits.map((trait) => {
                        const key = CONFIG.PF2E.weaponTraits[trait] ?? trait;
                        const option: CharacterStrikeTrait = {
                            name: trait,
                            label: key,
                            toggle: false,
                        };
                        return option;
                    }),
                );
                if (
                    action.attackRollType === 'PF2E.NPCAttackRanged' &&
                    !action.traits.some((trait) => trait.name === 'range')
                ) {
                    action.traits.splice(1, 0, {
                        name: 'range',
                        label: game.i18n.localize('PF2E.TraitRange'),
                        toggle: false,
                    });
                }
                // Add a damage roll breakdown
                action.damageBreakdown = Object.values(item.data.damageRolls).flatMap((roll) => {
                    return [
                        `${roll.damage} ${game.i18n.localize(
                            CONFIG.PF2E.damageTypes[roll.damageType as keyof ConfigPF2e['PF2E']['damageTypes']],
                        )}`,
                    ];
                });
                // Add attack effects to traits.
                const attackTraits = item.data.attackEffects.value.map((attackEffect: string) => {
                    return {
                        name: attackEffect.toLowerCase(),
                        label: attackEffect,
                        toggle: false,
                    };
                });
                action.traits.push(...attackTraits);
                // Add the base attack roll (used for determining on-hit)
                action.attack = adaptRoll(async (args) => {
                    const attackEffects = await this.getAttackEffects(item);
                    const rollNotes = notes.concat(attackEffects);
                    const options = (args.options ?? []).concat(item.data.traits.value); // always add all weapon traits as options
                    CheckPF2e.roll(
                        new CheckModifier(`Strike: ${action.name}`, action),
                        { actor: this, type: 'attack-roll', options, notes: rollNotes, dc: args.dc },
                        args.event,
                    );
                });
                action.roll = action.attack;

                const map = ItemPF2e.calculateMap(item);
                action.variants = [
                    {
                        label: `Strike ${action.totalModifier < 0 ? '' : '+'}${action.totalModifier}`,
                        roll: adaptRoll(async (args) => {
                            const attackEffects = await this.getAttackEffects(item);
                            const rollNotes = notes.concat(attackEffects);
                            const options = (args.options ?? []).concat(item.data.traits.value); // always add all weapon traits as options
                            options.push('constrict');
                            CheckPF2e.roll(
                                new CheckModifier(`Strike: ${action.name}`, action),
                                { actor: this, type: 'attack-roll', options, notes: rollNotes, dc: args.dc },
                                args.event,
                            );
                        }),
                    },
                    {
                        label: `MAP ${map.map2}`,
                        roll: adaptRoll(async (args) => {
                            const attackEffects = await this.getAttackEffects(item);
                            const rollNotes = notes.concat(attackEffects);
                            const options = (args.options ?? []).concat(item.data.traits.value); // always add all weapon traits as options
                            CheckPF2e.roll(
                                new CheckModifier(`Strike: ${action.name}`, action, [
                                    new ModifierPF2e('PF2E.MultipleAttackPenalty', map.map2, MODIFIER_TYPE.UNTYPED),
                                ]),
                                { actor: this, type: 'attack-roll', options, notes: rollNotes, dc: args.dc },
                                args.event,
                            );
                        }),
                    },
                    {
                        label: `MAP ${map.map3}`,
                        roll: adaptRoll(async (args) => {
                            const attackEffects = await this.getAttackEffects(item);
                            const rollNotes = notes.concat(attackEffects);
                            const options = (args.options ?? []).concat(item.data.traits.value); // always add all weapon traits as options
                            CheckPF2e.roll(
                                new CheckModifier(`Strike: ${action.name}`, action, [
                                    new ModifierPF2e('PF2E.MultipleAttackPenalty', map.map3, MODIFIER_TYPE.UNTYPED),
                                ]),
                                { actor: this, type: 'attack-roll', options, notes: rollNotes, dc: args.dc },
                                args.event,
                            );
                        }),
                    },
                ];
                action.damage = adaptRoll((args) => {
                    const options = (args.options ?? []).concat(item.data.traits.value); // always add all weapon traits as options
                    const damage = PF2WeaponDamage.calculateStrikeNPC(
                        item,
                        actorData,
                        action.traits,
                        statisticsModifiers,
                        damageDice,
                        1,
                        options,
                        rollNotes,
                    );
                    PF2DamageRoll.roll(
                        damage,
                        { type: 'damage-roll', outcome: 'success', options },
                        args.event,
                        args.callback,
                    );
                });
                action.critical = adaptRoll((args) => {
                    const options = (args.options ?? []).concat(item.data.traits.value); // always add all weapon traits as options
                    const damage = PF2WeaponDamage.calculateStrikeNPC(
                        item,
                        actorData,
                        action.traits,
                        statisticsModifiers,
                        damageDice,
                        1,
                        options,
                        rollNotes,
                    );
                    PF2DamageRoll.roll(
                        damage,
                        { type: 'damage-roll', outcome: 'criticalSuccess', options },
                        args.event,
                        args.callback,
                    );
                });

                data.actions.push(action);
            }
        }
    }

    private updateTokenAttitude(attitude: string) {
        const disposition = NPCPF2e.mapNPCAttitudeToTokenDisposition(attitude);
        const tokens = this._getTokenData();

        for (const key of Object.keys(tokens)) {
            const token = tokens[key];
            token.disposition = disposition;
        }

        const dispositionActorUpdate = {
            'token.disposition': disposition,
            attitude,
        };

        this._updateAllTokens(dispositionActorUpdate, tokens);
    }

    private static mapNPCAttitudeToTokenDisposition(attitude: string): number {
        if (attitude === null) {
            return CONST.TOKEN_DISPOSITIONS.HOSTILE;
        }

        if (attitude === 'hostile') {
            return CONST.TOKEN_DISPOSITIONS.HOSTILE;
        } else if (attitude === 'unfriendly' || attitude === 'indifferent') {
            return CONST.TOKEN_DISPOSITIONS.NEUTRAL;
        } else {
            return CONST.TOKEN_DISPOSITIONS.FRIENDLY;
        }
    }

    private static mapTokenDispositionToNPCAttitude(disposition: number): string {
        if (disposition === CONST.TOKEN_DISPOSITIONS.FRIENDLY) {
            return 'friendly';
        } else if (disposition === CONST.TOKEN_DISPOSITIONS.NEUTRAL) {
            return 'indifferent';
        } else {
            return 'hostile';
        }
    }

    protected async getAttackEffects(item: MeleeData): Promise<PF2RollNote[]> {
        const notes: PF2RollNote[] = [];
        for (const attackEffect of item.data.attackEffects.value) {
            const effectItem = this.data.items.find((item) => item.name.toLowerCase() === attackEffect.toLowerCase());
            const note = new PF2RollNote('all', '');
            if (effectItem) {
                // Get description from the actor item.
                const description = effectItem.data.description.value;
                note.text = `<div style="display: inline-block; font-weight: normal; line-height: 1.3em;" data-visibility="gm"><p><strong>${attackEffect}</strong></p>${description}</div>`;
                notes.push(note);
            } else {
                // Get description from the bestiary glossary compendium.
                const compendium = game.packs.get('pf2e.bestiary-ability-glossary-srd');
                if (compendium) {
                    const itemId =
                        (await compendium.getIndex())?.find((entry) => entry.name === attackEffect)?._id ?? '';
                    const packItem = (await compendium.getEntry(itemId)) as ActionData;
                    if (packItem) {
                        const description = packItem.data.description.value;
                        note.text = `<div style="display: inline-block; font-weight: normal; line-height: 1.3em;" data-visibility="gm"><strong>${attackEffect}</strong> ${description}</div>`;
                        notes.push(note);
                    } else {
                        ui.notifications.warn(game.i18n.format('PF2E.NPC.AttackEffectMissing', { attackEffect }));
                    }
                }
            }
        }

        return notes;
    }

    protected _onUpdate(data: any, options: object, userId: string, context: object) {
        super._onUpdate(data, options, userId, context);

        const attitude = data?.data?.traits?.attitude?.value;

        if (attitude && game.userId === userId) {
            this.updateTokenAttitude(attitude);
        }
    }

    public updateNPCAttitudeFromDisposition(disposition: number) {
        this.data.data.traits.attitude.value = NPCPF2e.mapTokenDispositionToNPCAttitude(disposition);
    }
}

export interface NPCPF2e {
    data: NPCData;
    _data: NPCData;
}
