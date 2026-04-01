const fs = require('fs');
const path = require('path');

// Banco de mensagens variadas para simular conversas reais
const MESSAGES = {
    greetings: [
        'Oi, tudo bem?', 'E aí, como vai?', 'Boa tarde!', 'Bom dia!',
        'Oi oi', 'Oii', 'Eai', 'Fala!', 'Opa, beleza?',
        'Olá!', 'Oi, sumido(a)!', 'Eae, quanto tempo!',
        'Bom diaaa', 'Boa noiteee', 'Boa tardee',
        'Oie tudo bem com vc?', 'Ei, como vc tá?',
        'Oi flor!', 'Oi amiga!', 'Eai mano', 'Salve!',
        'Opa, e aí?', 'Oi meu bem', 'Ei sumido!',
        'Bom dia flor do dia', 'Oiii tudo bem?'
    ],
    responses: [
        'Tudo sim e vc?', 'To bem, graças a Deus', 'Tudo ótimo!',
        'Tudo tranquilo', 'De boa', 'Na paz', 'Tudo joia',
        'To bem sim!', 'Mais ou menos', 'Correria né',
        'Tudo certinho', 'Suave', 'Bem demais',
        'Tô bem! E por aí?', 'Tudo certo, e vc?',
        'Na correria mas tô bem', 'Aqui firme!',
        'De boas, e tu?', 'Tudo em cima', 'Bem e vc?',
        'Melhor agora', 'Tô sobrevivendo kkk', 'Tudo nos trinques',
        'Ótima, e vc?', 'Na luta como sempre'
    ],
    casual: [
        'Kkkkk', 'Verdade', 'Sim sim', 'Com certeza',
        'Pois é', 'Né?', 'Exato', 'Isso mesmo',
        'Aham', 'Uhum', 'Tá certo', 'Entendi',
        'Massa', 'Show', 'Top', 'Boa!',
        'Demais', 'Sério?', 'Nossa!', 'Caramba',
        'Que legal!', 'Adorei', 'Maravilha', 'Perfeito',
        'Kkkk boa', 'Hahahaha', 'Rsrs', 'Kkkkkkk',
        'Tô ligado', 'Ah sim', 'Pode crer', 'Boto fé',
        'Tá doido', 'Eita', 'Mds', 'Ah não kkk',
        'Que isso kkk', 'Rapaz...', 'Misericórdia',
        'Oxe', 'Vish', 'Ave maria', 'Meu Deus'
    ],
    questions: [
        'O que vc tá fazendo?', 'Viu aquele negócio?',
        'Vc tá ocupado(a)?', 'Pode falar agora?',
        'Já almoçou?', 'Já jantou?', 'Vai sair hoje?',
        'Viu o jogo ontem?', 'Assistiu aquela série?',
        'O que vc acha?', 'Conhece alguém que faz isso?',
        'Tá calor aí tbm?', 'Choveu aí?', 'Vc trabalha amanhã?',
        'Qual o nome daquele lugar?', 'Lembra daquilo?',
        'Vc tem o contato?', 'Sabe onde vende?',
        'Onde vc comprou?', 'Quanto custou?',
        'Já viu esse filme?', 'Conhece esse lugar?',
        'Vc vai na festa?', 'Que horas vc sai?',
        'Sabe de alguma novidade?', 'Vc gosta disso?'
    ],
    farewell: [
        'Bom, vou nessa', 'Tenho que ir', 'Depois a gente se fala',
        'Até mais!', 'Tchau!', 'Beijos!', 'Abraços!',
        'Fui!', 'Valeu!', 'Falou!', 'Até depois',
        'Bjs', 'Flw', 'Tmj', 'Até!',
        'Boa noite, vou dormir', 'To indo, depois falo',
        'Preciso desligar', 'Vou trabalhar', 'Até amanhã!',
        'Vou ali e já volto', 'Depois te conto',
        'Boa noite povo', 'Durma bem', 'Descansa!'
    ],
    group_chat: [
        'Bom dia grupo!', 'Gente, vcs viram isso?',
        'Alguém sabe?', 'Concordo!', 'Penso igual',
        'Não sabia disso', 'Que interessante', 'Muito bom!',
        'Obrigado por compartilhar', 'Valeu pela info',
        'Boa noite pessoal', 'Oi gente!', 'Opa',
        'Alguém aí?', 'Olha isso kkk', 'Que top!',
        'Amei!', 'Maravilhoso!', 'Muito legal isso',
        'Caramba, não acredito', 'Sério isso?', 'Gente!!!',
        'Esquece o passado', 'Ficou louco', 'Tá abafado',
        'Sem chance', 'Imagina isso', 'Que dia hein',
        'Não aguento mais', 'Só quero paz', 'Vida que segue',
        'Cada um cada um', 'Ninguém merece', 'Tô por fora',
        'Deixa pra lá', 'Bora lá galera', 'Partiu!',
        'Foco total', 'Deus é bom o tempo todo',
        'Gratidão sempre', 'Força guerreiros', 'Boa semana pra todos',
        'Que Deus abençoe', 'Isso aí pessoal', 'Amém'
    ],
    status_texts: [
        '☀️ Bom dia!', '🌙 Boa noite!', '💪 Foco!',
        '🙏 Gratidão', '❤️ Família', '📱 Online',
        '🏠 Em casa', '☕ Café', '🎵 Ouvindo música',
        '📚 Estudando', '💼 Trabalhando', '🏃 Se exercitando',
        '🍕 Hora do lanche', '😊 Feliz', '🌈 Dia lindo!',
        '✨ Energia positiva', '🔥 Motivado', '🌊 Na paz',
        '🎯 Focado', '💪 Determinação'
    ],
    long_messages: [
        'Gente, vocês não vão acreditar no que aconteceu comigo hoje, eu tava indo pro trabalho quando vi uma coisa incrível',
        'Eu tava pensando aqui e acho que a gente devia fazer alguma coisa diferente esse final de semana, tipo sei lá',
        'Mano, o dia hoje tá impossível, sol de rachar, ainda bem que to com minha garrafinha de água aqui',
        'Acabei de ver no jornal que vai ter promoção no shopping semana que vem, bora?',
        'Nossa vocês precisam ver o tanto de coisa bonita que eu achei, impressionante demais',
        'Tô aqui esperando o ônibus e o trânsito tá um caos total, não sei que horas chego',
        'Alguém sabe de algum lugar bom pra comer por aqui? Tô com uma fome que não dá',
        'Acabei de chegar do mercado e gastei uma fortuna, tá tudo caro demais',
        'Gente que saudade de vocês, faz muito tempo que a gente não se encontra pra conversar',
        'Hoje o dia foi muito produtivo, consegui resolver tudo que precisava, agora é descansar'
    ]
};

// Localizações brasileiras aleatórias para envio
const LOCATIONS = [
    { lat: -23.5505, lng: -46.6333, name: 'São Paulo, SP' },
    { lat: -22.9068, lng: -43.1729, name: 'Rio de Janeiro, RJ' },
    { lat: -19.9167, lng: -43.9345, name: 'Belo Horizonte, MG' },
    { lat: -15.7801, lng: -47.9292, name: 'Brasília, DF' },
    { lat: -12.9714, lng: -38.5124, name: 'Salvador, BA' },
    { lat: -3.1190, lng: -60.0217, name: 'Manaus, AM' },
    { lat: -8.0476, lng: -34.8770, name: 'Recife, PE' },
    { lat: -25.4284, lng: -49.2733, name: 'Curitiba, PR' },
    { lat: -30.0346, lng: -51.2177, name: 'Porto Alegre, RS' },
    { lat: -3.7172, lng: -38.5433, name: 'Fortaleza, CE' },
    { lat: -16.6799, lng: -49.2550, name: 'Goiânia, GO' },
    { lat: -1.4558, lng: -48.5024, name: 'Belém, PA' },
    { lat: -20.3155, lng: -40.3128, name: 'Vitória, ES' },
    { lat: -27.5954, lng: -48.5480, name: 'Florianópolis, SC' },
    { lat: -2.5307, lng: -44.2826, name: 'São Luís, MA' },
    { lat: -5.7945, lng: -35.2110, name: 'Natal, RN' },
    { lat: -9.6658, lng: -35.7353, name: 'Maceió, AL' },
    { lat: -10.9472, lng: -37.0731, name: 'Aracaju, SE' },
    { lat: -7.1195, lng: -34.8450, name: 'João Pessoa, PB' },
    { lat: -22.3281, lng: -49.0713, name: 'Bauru, SP' },
    { lat: -23.3045, lng: -51.1696, name: 'Londrina, PR' },
    { lat: -22.2176, lng: -49.9451, name: 'Marília, SP' },
    { lat: -21.1767, lng: -47.8208, name: 'Ribeirão Preto, SP' },
    { lat: -20.8202, lng: -49.3788, name: 'São José do Rio Preto, SP' },
    { lat: -23.9608, lng: -46.3336, name: 'Santos, SP' },
    { lat: -22.9099, lng: -47.0626, name: 'Campinas, SP' },
    { lat: -23.1896, lng: -45.8841, name: 'São José dos Campos, SP' },
    { lat: -15.8917, lng: -48.0833, name: 'Taguatinga, DF' },
    { lat: -23.5200, lng: -46.1836, name: 'Mogi das Cruzes, SP' },
    { lat: -23.6500, lng: -46.5300, name: 'Santo André, SP' }
];

// Emojis para reações
const REACTION_EMOJIS = ['👍', '❤️', '😂', '😮', '😢', '🙏', '🔥', '👏', '😍', '💯'];

class MessageFactory {
    // Gera sufixo aleatório de letras maiúsculas (estilo ProtectZap)
    static getRandomSuffix(length = 8) {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        let result = '';
        for (let i = 0; i < length; i++) {
            result += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return result;
    }

    // Retorna mensagem COM sufixo aleatório para evitar detecção de duplicata
    static getMessageWithSuffix(category) {
        const msg = this.getRandomMessage(category);
        // 70% chance de adicionar sufixo (variação)
        if (Math.random() < 0.7) {
            return `${msg} ${this.getRandomSuffix()}`;
        }
        return msg;
    }

    static getRandomMessage(category) {
        const messages = MESSAGES[category];
        if (!messages) return 'Oi';
        return messages[Math.floor(Math.random() * messages.length)];
    }

    static getConversationFlow() {
        // Simula um mini-diálogo
        const flows = [
            ['greetings', 'responses', 'casual'],
            ['greetings', 'responses', 'questions', 'casual'],
            ['greetings', 'questions', 'responses'],
            ['greetings', 'responses', 'casual', 'farewell'],
            ['greetings', 'casual'],
            ['questions', 'responses'],
            ['casual', 'casual'],
            ['greetings', 'responses', 'questions', 'casual', 'farewell']
        ];
        return flows[Math.floor(Math.random() * flows.length)];
    }

    static getRandomReaction() {
        return REACTION_EMOJIS[Math.floor(Math.random() * REACTION_EMOJIS.length)];
    }

    static getStatusText() {
        return this.getMessageWithSuffix('status_texts');
    }

    static getGroupMessage() {
        // 30% chance de mensagem longa, 70% curta - ambas com sufixo
        if (Math.random() < 0.3) {
            return this.getLongMessage();
        }
        return this.getMessageWithSuffix('group_chat');
    }

    static getLongMessage() {
        const msg = this.getRandomMessage('long_messages');
        return `${msg} ${this.getRandomSuffix()}`;
    }

    // Retorna localização aleatória brasileira
    static getRandomLocation() {
        const loc = LOCATIONS[Math.floor(Math.random() * LOCATIONS.length)];
        // Adiciona pequena variação para não ser exatamente igual
        const latVar = (Math.random() - 0.5) * 0.02;
        const lngVar = (Math.random() - 0.5) * 0.02;
        return {
            degreesLatitude: loc.lat + latVar,
            degreesLongitude: loc.lng + lngVar,
            name: loc.name,
            address: loc.name + ', Brasil'
        };
    }

    static getGroupName() {
        const names = [
            'Família ❤️', 'Amigos 🤝', 'Galera 🔥', 'Grupo Top 💪',
            'Zueira 😂', 'Trabalho 💼', 'Faculdade 📚', 'Vizinhos 🏠',
            'Churras 🥩', 'Futebol ⚽', 'Receitas 🍳', 'Músicas 🎵',
            'Filmes 🎬', 'Viagem ✈️', 'Jogos 🎮', 'Notícias 📰',
            'Memes 🤣', 'Fitness 🏋️', 'Cozinheiros 👨‍🍳', 'Tech 💻'
        ];
        return names[Math.floor(Math.random() * names.length)];
    }

    // Get random media file from the media directory
    static getRandomMedia(type) {
        const mediaDir = path.join(__dirname, '..', '..', 'media', type);
        if (!fs.existsSync(mediaDir)) return null;

        const files = fs.readdirSync(mediaDir).filter(f => !f.startsWith('.'));
        if (files.length === 0) return null;

        const file = files[Math.floor(Math.random() * files.length)];
        return path.join(mediaDir, file);
    }

    // Generate random delay between actions (in ms)
    static getRandomDelay(minSeconds, maxSeconds) {
        const min = minSeconds * 1000;
        const max = maxSeconds * 1000;
        return Math.floor(Math.random() * (max - min + 1)) + min;
    }

    // Check if current hour is within active hours
    static isActiveHour(startHour, endHour) {
        const now = new Date();
        const hour = now.getHours();
        return hour >= startHour && hour < endHour;
    }

    // Get typing delay based on message length (simulate human typing)
    static getTypingDelay(message) {
        // ~200ms per character, with some randomness
        const baseDelay = message.length * 150;
        const randomFactor = 0.5 + Math.random();
        return Math.min(Math.max(baseDelay * randomFactor, 1000), 8000);
    }
}

module.exports = MessageFactory;
